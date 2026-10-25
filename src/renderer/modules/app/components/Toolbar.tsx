import React from "react";
import { FiHelpCircle, FiMoon, FiSettings, FiSun } from "react-icons/fi";
import { selectTheme, useUiStore } from "@renderer/state/uiStore";
import { UI_EVENTS } from "../lib/uiEvents";
import "./Toolbar.css";

export const Toolbar: React.FC = () => {
  const theme = useUiStore(selectTheme);
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <nav className="toolbar glass" aria-label="App controls">
      <button
        type="button"
        className="icon-button"
        aria-label={`Switch to ${nextTheme} theme`}
        title={`Switch to ${nextTheme} theme`}
        onClick={() => useUiStore.getState().setTheme(nextTheme)}
      >
        {theme === "dark" ? <FiSun aria-hidden /> : <FiMoon aria-hidden />}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Open settings"
        title="Open settings"
        onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.OPEN_SETTINGS_MODAL))}
      >
        <FiSettings aria-hidden />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Show the getting started guide"
        title="Show the getting started guide"
        onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.SHOW_ONBOARDING))}
      >
        <FiHelpCircle aria-hidden />
      </button>
    </nav>
  );
};
