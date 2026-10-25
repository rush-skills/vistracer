import { create } from "zustand";
import type { ThemeName, UiPreferences } from "@common/ipc";
import { layerById, type LayerId } from "@renderer/lib/layers";
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
  /** Layer notices the user accepted (`LayerDefinition.consent`). */
  consents: Record<string, boolean>;
  /** A layer waiting for its notice to be accepted (LayerConsentDialog). */
  pendingConsent?: LayerId;
  /** Saved choices were read. Until then (or when reading failed) nothing is written. */
  loaded: boolean;
  paletteOpen: boolean;
  load: () => Promise<void>;
  setTheme: (theme: ThemeName) => void;
  /**
   * Shows or hides a layer. Showing a layer with a notice the user has not
   * accepted yet opens the notice instead; the layer stays off until then.
   */
  setLayerVisible: (id: LayerId, visible: boolean) => void;
  acceptConsent: () => void;
  declineConsent: () => void;
  setPanelCollapsed: (id: PanelId, collapsed: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  /** Resolves when every change so far is written (the backend reads them). */
  whenSaved: () => Promise<void>;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

// Writes run one after another, each with the state at the time it runs,
// so the last write always carries the latest choices.
let saving: Promise<void> = Promise.resolve();

function persist(): void {
  saving = saving.then(async () => {
    const { theme, layers, collapsed, consents, loaded } = useUiStore.getState();
    if (!loaded) {
      return;
    }
    const value: UiPreferences = { theme: theme ?? DEFAULT_THEME, layers, collapsed, consents };
    try {
      await window.visTracer.setSettings("preferences.ui", value);
    } catch (error) {
      useNoticeStore
        .getState()
        .show(`Could not save the layout and layer choices: ${errorText(error)}`, "error");
    }
  });
}

/** Theme, layer switches, accepted notices and panel layout, saved in `preferences.ui`. */
export const useUiStore = create<UiStore>((set, get) => ({
  layers: {},
  collapsed: {},
  consents: {},
  loaded: false,
  paletteOpen: false,
  load: async () => {
    let saved;
    try {
      saved = normalizeUiPreferences(await window.visTracer.getSettings("preferences.ui"));
    } catch (error) {
      // Writing now would replace the saved choices with the defaults.
      console.warn("Could not read the UI preferences; changes are not saved.", error);
      useNoticeStore
        .getState()
        .show(
          `Could not read the saved layout and layer choices (${errorText(error)}); changes in this session are not saved.`,
          "error"
        );
      return;
    }
    // Choices made while the file loaded win over the saved ones.
    const early = get();
    const changedEarly =
      early.theme !== undefined ||
      Object.keys(early.layers).length > 0 ||
      Object.keys(early.collapsed).length > 0 ||
      Object.keys(early.consents).length > 0;
    set({
      theme: early.theme ?? saved.theme,
      layers: { ...saved.layers, ...early.layers },
      collapsed: { ...saved.collapsed, ...early.collapsed },
      consents: { ...saved.consents, ...early.consents },
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
    if (visible && layerById(id)?.consent && !get().consents[id]) {
      set({ pendingConsent: id });
      return;
    }
    set((state) => ({ layers: { ...state.layers, [id]: visible } }));
    persist();
  },
  acceptConsent: () => {
    const id = get().pendingConsent;
    if (!id) {
      return;
    }
    set((state) => ({
      pendingConsent: undefined,
      consents: { ...state.consents, [id]: true },
      layers: { ...state.layers, [id]: true }
    }));
    persist();
  },
  declineConsent: () => set({ pendingConsent: undefined }),
  setPanelCollapsed: (id, collapsed) => {
    set((state) => ({ collapsed: { ...state.collapsed, [id]: collapsed } }));
    persist();
  },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  whenSaved: () => saving
}));

export const selectTheme = (state: UiStore): ThemeName => state.theme ?? DEFAULT_THEME;

export const selectPanelCollapsed =
  (id: PanelId) =>
  (state: UiStore): boolean =>
    state.collapsed[id] ?? PANELS[id].defaultCollapsed;
