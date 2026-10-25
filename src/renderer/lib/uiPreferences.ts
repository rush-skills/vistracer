import type { ThemeName, UiPreferences } from "@common/ipc";

/** Panels that collapse; their state is saved in `preferences.ui.collapsed`. */
export const PANELS = {
  "trace-options": { label: "Trace options", defaultCollapsed: true },
  hops: { label: "Hop details", defaultCollapsed: false },
  timeline: { label: "Hop timeline", defaultCollapsed: false },
  layers: { label: "Layers", defaultCollapsed: true }
} as const satisfies Record<string, { label: string; defaultCollapsed: boolean }>;

export type PanelId = keyof typeof PANELS;

export const DEFAULT_THEME: ThemeName = "dark";

/** Mirrors `is_registry_id` in persistence.rs, which rejects anything else. */
const REGISTRY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_ENTRIES = 64;

export type SavedUiPreferences = Omit<UiPreferences, "theme"> & { theme?: ThemeName };

function switches(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, boolean] =>
          REGISTRY_ID.test(entry[0]) && typeof entry[1] === "boolean"
      )
      .slice(0, MAX_ENTRIES)
  );
}

/**
 * Parses `preferences.ui` from the backend. Anything malformed is dropped,
 * so that entry falls back to its default.
 */
export function normalizeUiPreferences(raw: unknown): SavedUiPreferences {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    theme: value.theme === "dark" || value.theme === "light" ? value.theme : undefined,
    layers: switches(value.layers),
    collapsed: switches(value.collapsed)
  };
}
