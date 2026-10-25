import { create } from "zustand";
import type { ThemeName, UiPreferences } from "@common/ipc";
import type { LayerId } from "@renderer/lib/layers";
import {
  DEFAULT_THEME,
  PANELS,
  normalizeUiPreferences,
  type PanelId
} from "@renderer/lib/uiPreferences";
import { useNoticeStore } from "./noticeStore";

export interface UiStore {
  /** Undefined until loaded or chosen: DEFAULT_THEME applies. */
  theme?: ThemeName;
  /** Only the switches the user changed; the rest use the registry defaults. */
  layers: Record<string, boolean>;
  collapsed: Record<string, boolean>;
  loaded: boolean;
  paletteOpen: boolean;
  load: () => Promise<void>;
  setTheme: (theme: ThemeName) => void;
  setLayerVisible: (id: LayerId, visible: boolean) => void;
  setPanelCollapsed: (id: PanelId, collapsed: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

// Writes run one after another, each with the state at the time it runs,
// so the last write always carries the latest choices.
let saving: Promise<void> = Promise.resolve();

function persist(): void {
  saving = saving.then(async () => {
    const { theme, layers, collapsed, loaded } = useUiStore.getState();
    if (!loaded) {
      return;
    }
    const value: UiPreferences = { theme: theme ?? DEFAULT_THEME, layers, collapsed };
    try {
      await window.visTracer.setSettings("preferences.ui", value);
    } catch (error) {
      useNoticeStore
        .getState()
        .show(`Could not save the layout and layer choices: ${errorText(error)}`, "error");
    }
  });
}

/** Theme, layer switches and panel layout, saved in `preferences.ui`. */
export const useUiStore = create<UiStore>((set, get) => ({
  layers: {},
  collapsed: {},
  loaded: false,
  paletteOpen: false,
  load: async () => {
    let saved = normalizeUiPreferences(undefined);
    try {
      saved = normalizeUiPreferences(await window.visTracer.getSettings("preferences.ui"));
    } catch (error) {
      console.warn("Could not read the UI preferences; using the defaults.", error);
    }
    // Choices made while the file loaded win over the saved ones.
    const early = get();
    const changedEarly =
      early.theme !== undefined ||
      Object.keys(early.layers).length > 0 ||
      Object.keys(early.collapsed).length > 0;
    set({
      theme: early.theme ?? saved.theme,
      layers: { ...saved.layers, ...early.layers },
      collapsed: { ...saved.collapsed, ...early.collapsed },
      loaded: true
    });
    if (changedEarly) {
      persist();
    }
  },
  setTheme: (theme) => {
    set({ theme });
    persist();
  },
  setLayerVisible: (id, visible) => {
    set((state) => ({ layers: { ...state.layers, [id]: visible } }));
    persist();
  },
  setPanelCollapsed: (id, collapsed) => {
    set((state) => ({ collapsed: { ...state.collapsed, [id]: collapsed } }));
    persist();
  },
  setPaletteOpen: (open) => set({ paletteOpen: open })
}));

export const selectTheme = (state: UiStore): ThemeName => state.theme ?? DEFAULT_THEME;

export const selectPanelCollapsed =
  (id: PanelId) =>
  (state: UiStore): boolean =>
    state.collapsed[id] ?? PANELS[id].defaultCollapsed;
