import React, { useMemo } from "react";
import { FiX } from "react-icons/fi";
import {
  LAYERS,
  LAYER_GROUPS,
  layerVisibility,
  type LayerDefinition,
  type LayerId
} from "@renderer/lib/layers";
import { usePanel } from "@renderer/hooks/usePanel";
import { useInfraStore, type InfraSources } from "@renderer/state/infraStore";
import { useUiStore } from "@renderer/state/uiStore";
import "./LayerPanel.css";

export const LAYER_PANEL_ID = "layer-panel";
export const LAYERS_TOGGLE_ID = "layers-toggle";

/** What the panel says under a shown layer about its data, if anything. */
function sourceStatus(layer: LayerDefinition, sources: InfraSources): string | undefined {
  if (!layer.data) {
    return undefined;
  }
  const source = sources[layer.data];
  switch (source.status) {
    case "loading":
      return "Loading…";
    case "unavailable":
      return source.message;
    case "error":
      return `Could not load: ${source.message} Turn the layer off and on to try again.`;
    case "ready":
      return source.note;
    default:
      return undefined;
  }
}

/** Show/hide switches for every entry of the layer registry, by group. */
export const LayerPanel: React.FC = () => {
  const [collapsed, setCollapsed] = usePanel("layers");
  const saved = useUiStore((state) => state.layers);
  const visibility = useMemo(() => layerVisibility(saved), [saved]);
  const sources = useInfraStore((state) => state.sources);

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
          {(LAYERS as readonly LayerDefinition[])
            .filter((layer) => layer.group === group.id)
            .map((layer) => {
              const id = layer.id as LayerId;
              const parentOff = layer.parent != null && !visibility[layer.parent as LayerId];
              const status = visibility[id] && !parentOff ? sourceStatus(layer, sources) : undefined;
              return (
                <div
                  key={layer.id}
                  className={`layer-panel__item${layer.parent ? " layer-panel__item--child" : ""}`}
                >
                  <span className="layer-panel__text">
                    <span id={`layer-${layer.id}-label`} className="layer-panel__label">
                      {layer.swatch && (
                        <span
                          className="layer-panel__swatch"
                          aria-hidden
                          style={{ background: layer.swatch.fill, borderColor: layer.swatch.outline }}
                        />
                      )}
                      {layer.label}
                    </span>
                    <small id={`layer-${layer.id}-description`}>
                      {layer.description}
                      {parentOff && ` Turn on ${layerLabel(layer.parent)} to see it.`}
                    </small>
                    {status && (
                      <small className="layer-panel__status" role="status">
                        {status}
                      </small>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={visibility[id]}
                    aria-labelledby={`layer-${layer.id}-label`}
                    aria-describedby={`layer-${layer.id}-description`}
                    onChange={(event) =>
                      useUiStore.getState().setLayerVisible(id, event.target.checked)
                    }
                  />
                </div>
              );
            })}
        </fieldset>
      ))}
    </section>
  );
};

function layerLabel(id: string | undefined): string {
  return (LAYERS as readonly LayerDefinition[]).find((layer) => layer.id === id)?.label ?? "";
}
