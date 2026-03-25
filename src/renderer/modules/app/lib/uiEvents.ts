export const UI_EVENTS = {
  OPEN_SETTINGS_MODAL: "vistracer:open-settings-modal",
  SHOW_ONBOARDING: "vistracer:show-onboarding",
  EXPAND_INTEGRATIONS_PANEL: "vistracer:expand-integrations"
} as const;

export type UiEvent = (typeof UI_EVENTS)[keyof typeof UI_EVENTS];
