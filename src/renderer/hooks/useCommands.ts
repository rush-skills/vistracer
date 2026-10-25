import { useMemo } from "react";
import {
  buildCommands,
  type Command,
  type CommandActions,
  type CommandContext
} from "@renderer/lib/commands";
import { layerVisibility } from "@renderer/lib/layers";
import { PANELS, type PanelId } from "@renderer/lib/uiPreferences";
import { useExportStore } from "@renderer/state/exportStore";
import { useNoticeStore } from "@renderer/state/noticeStore";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import { selectTheme, useUiStore } from "@renderer/state/uiStore";
import { DEFAULT_DWELL_SECONDS } from "../modules/app/lib/exportCapture";
import { UI_EVENTS, requestTrace } from "../modules/app/lib/uiEvents";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

const ACTIONS: CommandActions = {
  startTrace: requestTrace,
  rerun: (request) => void useTracerouteStore.getState().startRun(request),
  cancelTrace: () => void useTracerouteStore.getState().cancelRun(),
  selectHop: (hopIndex) => useTracerouteStore.getState().setSelectedHop(hopIndex),
  setLayerVisible: (id, visible) => useUiStore.getState().setLayerVisible(id, visible),
  setTheme: (theme) => useUiStore.getState().setTheme(theme),
  setPanelCollapsed: (id, collapsed) => useUiStore.getState().setPanelCollapsed(id, collapsed),
  openSettings: () => window.dispatchEvent(new CustomEvent(UI_EVENTS.OPEN_SETTINGS_MODAL)),
  showGuide: () => window.dispatchEvent(new CustomEvent(UI_EVENTS.SHOW_ONBOARDING)),
  exportAs: (format) =>
    void useExportStore.getState().start({ format, dwellSeconds: DEFAULT_DWELL_SECONDS }),
  openExportDialog: () => useExportStore.getState().openDialog(),
  clearTileCache: () => {
    const notices = useNoticeStore.getState();
    window.visTracer.clearTileCache().then(
      () => notices.show("Cleared the tile cache."),
      (error: unknown) => notices.show(`Could not clear the tile cache: ${errorText(error)}`, "error")
    );
  }
};

/** The app state the commands depend on. */
export function useCommandContext(): CommandContext {
  const running = useTracerouteStore((state) => state.status === "running");
  const run = useTracerouteStore(selectCurrentRun);
  const savedLayers = useUiStore((state) => state.layers);
  const savedCollapsed = useUiStore((state) => state.collapsed);
  const theme = useUiStore(selectTheme);
  const exporting = useExportStore((state) => state.working);
  return useMemo(
    () => ({
      running,
      run,
      layers: layerVisibility(savedLayers),
      theme,
      collapsed: Object.fromEntries(
        (Object.keys(PANELS) as PanelId[]).map((id) => [
          id,
          savedCollapsed[id] ?? PANELS[id].defaultCollapsed
        ])
      ) as Record<PanelId, boolean>,
      exporting,
      actions: ACTIONS
    }),
    [running, run, savedLayers, savedCollapsed, theme, exporting]
  );
}

export function useCommands(): Command[] {
  const context = useCommandContext();
  return useMemo(() => buildCommands(context), [context]);
}

/** One command of the registry, for a button that runs it. */
export function useCommand(id: string): Command {
  const command = useCommands().find((candidate) => candidate.id === id);
  if (!command) {
    throw new Error(`No command ${id}`);
  }
  return command;
}
