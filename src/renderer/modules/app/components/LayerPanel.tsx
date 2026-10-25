import React, { useMemo } from "react";
import { FiX } from "react-icons/fi";
import { LAYERS, LAYER_GROUPS, layerVisibility } from "@renderer/lib/layers";
import { usePanel } from "@renderer/hooks/usePanel";
import { useUiStore } from "@renderer/state/uiStore";
import "./LayerPanel.css";

export const LAYER_PANEL_ID = "layer-panel";
export const LAYERS_TOGGLE_ID = "layers-toggle";

/** Show/hide switches for every entry of the layer registry, by group. */
export const LayerPanel: React.FC = () => {
  const [collapsed, setCollapsed] = usePanel("layers");
  const saved = useUiStore((state) => state.layers);
  const visibility = useMemo(() => layerVisibility(saved), [saved]);

  if (collapsed) {
    return null;
  }

  const close = () => {
    setCollapsed(true);
    document.getElementById(LAYERS_TOGGLE_ID)?.focus();
  };

  return (
    <section
      id={LAYER_PANEL_ID}
      className="layer-panel glass"
      aria-labelledby="layer-panel-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="layer-panel__header">
        <h2 id="layer-panel-title">Layers</h2>
        <button type="button" className="icon-button" aria-label="Close layers" onClick={close}>
          <FiX aria-hidden />
        </button>
      </header>
      {LAYER_GROUPS.map((group) => (
        <fieldset key={group.id} className="layer-panel__group">
          <legend>{group.label}</legend>
          {LAYERS.filter((layer) => layer.group === group.id).map((layer) => (
            <div key={layer.id} className="layer-panel__item">
              <span className="layer-panel__text">
                <span id={`layer-${layer.id}-label`}>{layer.label}</span>
                <small id={`layer-${layer.id}-description`}>{layer.description}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={visibility[layer.id]}
                aria-labelledby={`layer-${layer.id}-label`}
                aria-describedby={`layer-${layer.id}-description`}
                onChange={(event) =>
                  useUiStore.getState().setLayerVisible(layer.id, event.target.checked)
                }
              />
            </div>
          ))}
        </fieldset>
      ))}
    </section>
  );
};
