import { useCallback } from "react";
import type { PanelId } from "@renderer/lib/uiPreferences";
import { selectPanelCollapsed, useUiStore } from "@renderer/state/uiStore";

/** A panel's saved collapsed state and a setter that saves it. */
export function usePanel(id: PanelId): [collapsed: boolean, setCollapsed: (value: boolean) => void] {
  const collapsed = useUiStore(selectPanelCollapsed(id));
  const setCollapsed = useCallback(
    (value: boolean) => useUiStore.getState().setPanelCollapsed(id, value),
    [id]
  );
  return [collapsed, setCollapsed];
}
