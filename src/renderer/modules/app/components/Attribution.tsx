import React, { useEffect, useMemo, useRef, useState } from "react";
import { FiInfo, FiX } from "react-icons/fi";
import { ONLINE_IMAGERY_LAYER_ID } from "@common/ipc";
import { CREDITS, creditsChip, type CreditGroup } from "@renderer/lib/attribution";
import { layerVisibility } from "@renderer/lib/layers";
import { useUiStore } from "@renderer/state/uiStore";
import "./Attribution.css";

const GROUPS: CreditGroup[] = ["Globe", "Hop data", "Infrastructure", "Space"];
const PANEL_ID = "attribution-panel";

/**
 * A small credits button in the globe's corner. It opens the full list of
 * sources upwards, over the globe only while the user reads it.
 */
export const Attribution: React.FC = () => {
  const [open, setOpen] = useState(false);
  const savedLayers = useUiStore((state) => state.layers);
  const visibility = useMemo(() => layerVisibility(savedLayers), [savedLayers]);
  const online = visibility[ONLINE_IMAGERY_LAYER_ID];
  const credits = CREDITS.filter((credit) => credit.layer == null || visibility[credit.layer]);
  const chip = creditsChip(visibility);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      closeRef.current?.focus();
    }
  }, [open]);

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div className="attribution">
      {open && (
        <section
          id={PANEL_ID}
          className="attribution__panel glass"
          role="dialog"
          aria-labelledby="attribution-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <header className="attribution__header">
            <h2 id="attribution-title">Data sources and credits</h2>
            <button
              ref={closeRef}
              type="button"
              className="icon-button"
              aria-label="Close credits"
              onClick={close}
            >
              <FiX aria-hidden />
            </button>
          </header>
          {GROUPS.map((group) => (
            <section key={group} className="attribution__group" aria-label={group}>
              <h3>{group}</h3>
              <ul>
                {credits.filter((credit) => credit.group === group).map((credit) => (
                  <li key={credit.name}>
                    <strong>{credit.name}</strong> {credit.use}
                    <small>
                      {credit.licence}. {credit.source}
                      {credit.servesOnlineTiles && !online && ". Online tiles: off."}
                    </small>
                    {credit.notice && (
                      <small className="attribution__notice">{credit.notice}</small>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </section>
      )}
      <button
        ref={toggleRef}
        type="button"
        className="attribution__toggle"
        aria-label="Data sources and credits"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <FiInfo aria-hidden />
        <span>{chip}</span>
      </button>
    </div>
  );
};
