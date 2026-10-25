import React from "react";
import { FiHelpCircle, FiLayers, FiMoon, FiSearch, FiSettings, FiSun } from "react-icons/fi";
import { useCommands } from "@renderer/hooks/useCommands";
import type { Command } from "@renderer/lib/commands";
import { commandBarShortcutLabel } from "@renderer/lib/shortcuts";
import { selectPanelCollapsed, selectTheme, useUiStore } from "@renderer/state/uiStore";
import { LAYERS_TOGGLE_ID, LAYER_PANEL_ID } from "./LayerPanel";
import "./Toolbar.css";

/** A toolbar button that runs a command of the registry and is named after it. */
const CommandButton: React.FC<{ command: Command; children: React.ReactNode }> = ({
  command,
  children
}) => (
  <button
    type="button"
    className="icon-button"
    aria-label={command.title}
    title={command.title}
    disabled={Boolean(command.disabledReason)}
    onClick={command.run}
  >
    {children}
  </button>
);

export const Toolbar: React.FC = () => {
  const commands = useCommands();
  const command = (id: string) => {
    const found = commands.find((candidate) => candidate.id === id);
    if (!found) {
      throw new Error(`No command ${id}`);
    }
    return found;
  };
  const theme = useUiStore(selectTheme);
  const layersCollapsed = useUiStore(selectPanelCollapsed("layers"));
  const layers = command("panel.layers");
  const shortcut = commandBarShortcutLabel();

  return (
    <nav className="toolbar glass" aria-label="App controls">
      <button
        type="button"
        className="toolbar__command"
        aria-label={`Open the command bar (${shortcut})`}
        title={`Command bar (${shortcut})`}
        onClick={() => useUiStore.getState().setPaletteOpen(true)}
      >
        <FiSearch aria-hidden />
        <kbd>{shortcut}</kbd>
      </button>
      <button
        type="button"
        id={LAYERS_TOGGLE_ID}
        className="icon-button"
        aria-label="Layers"
        title={layers.title}
        aria-expanded={!layersCollapsed}
        aria-controls={LAYER_PANEL_ID}
        onClick={layers.run}
      >
        <FiLayers aria-hidden />
      </button>
      <CommandButton command={command("view.theme")}>
        {theme === "dark" ? <FiSun aria-hidden /> : <FiMoon aria-hidden />}
      </CommandButton>
      <CommandButton command={command("settings.open")}>
        <FiSettings aria-hidden />
      </CommandButton>
      <CommandButton command={command("help.guide")}>
        <FiHelpCircle aria-hidden />
      </CommandButton>
    </nav>
  );
};
