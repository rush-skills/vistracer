export const UI_EVENTS = {
  OPEN_SETTINGS_MODAL: "vistracer:open-settings-modal",
  SHOW_ONBOARDING: "vistracer:show-onboarding",
  EXPAND_INTEGRATIONS_PANEL: "vistracer:expand-integrations",
  /** detail: StartTraceDetail. The trace panel starts it with its current options. */
  START_TRACE: "vistracer:start-trace"
} as const;

export interface StartTraceDetail {
  target: string;
}

export function requestTrace(target: string): void {
  window.dispatchEvent(
    new CustomEvent<StartTraceDetail>(UI_EVENTS.START_TRACE, { detail: { target } })
  );
}

export type UiEvent = (typeof UI_EVENTS)[keyof typeof UI_EVENTS];
