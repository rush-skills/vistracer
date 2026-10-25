import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererApi } from "@common/bridge";
import { normalizeUiPreferences } from "@renderer/lib/uiPreferences";
import { useNoticeStore } from "../noticeStore";
import { selectPanelCollapsed, selectTheme, useUiStore } from "../uiStore";

const initial = useUiStore.getState();

let saved: unknown;
let api: { getSettings: ReturnType<typeof vi.fn>; setSettings: ReturnType<typeof vi.fn> };

/** Lets the queued settings writes run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  saved = undefined;
  api = {
    getSettings: vi.fn(async () => saved),
    setSettings: vi.fn().mockResolvedValue(undefined)
  };
  window.visTracer = api as unknown as RendererApi;
  useUiStore.setState(initial, true);
  useNoticeStore.getState().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeUiPreferences", () => {
  it("keeps valid entries and drops malformed ones", () => {
    expect(
      normalizeUiPreferences({
        theme: "light",
        layers: { rings: false, "Bad Id": true, labels: "no", "ixp-sites": true },
        collapsed: { hops: true }
      })
    ).toEqual({
      theme: "light",
      layers: { rings: false, "ixp-sites": true },
      collapsed: { hops: true },
      consents: {}
    });
    expect(normalizeUiPreferences({ theme: "neon", layers: [], collapsed: null })).toEqual({
      theme: undefined,
      layers: {},
      collapsed: {},
      consents: {}
    });
    expect(normalizeUiPreferences(undefined)).toEqual({
      theme: undefined,
      layers: {},
      collapsed: {},
      consents: {}
    });
    expect(
      normalizeUiPreferences({ consents: { "submarine-cables": true, "Bad Id": true, x: "yes" } })
        .consents
    ).toEqual({ "submarine-cables": true });
  });
});

describe("uiStore", () => {
  it("starts dark with the registry defaults before anything is saved", async () => {
    await useUiStore.getState().load();
    const state = useUiStore.getState();
    expect(selectTheme(state)).toBe("dark");
    expect(selectPanelCollapsed("hops")(state)).toBe(false);
    expect(selectPanelCollapsed("layers")(state)).toBe(true);
    expect(selectPanelCollapsed("trace-options")(state)).toBe(true);
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("loads saved choices and saves the whole preference object on each change", async () => {
    saved = { theme: "light", layers: { rings: false }, collapsed: { timeline: true } };
    await useUiStore.getState().load();
    expect(selectTheme(useUiStore.getState())).toBe("light");
    expect(selectPanelCollapsed("timeline")(useUiStore.getState())).toBe(true);

    useUiStore.getState().setPanelCollapsed("hops", true);
    await flush();
    expect(api.setSettings).toHaveBeenLastCalledWith("preferences.ui", {
      theme: "light",
      layers: { rings: false },
      collapsed: { timeline: true, hops: true },
      consents: {}
    });

    useUiStore.getState().setTheme("dark");
    useUiStore.getState().setLayerVisible("online-imagery", false);
    await flush();
    expect(api.setSettings).toHaveBeenLastCalledWith("preferences.ui", {
      theme: "dark",
      layers: { rings: false, "online-imagery": false },
      collapsed: { timeline: true, hops: true },
      consents: {}
    });
  });

  it("keeps choices made while the saved file loads", async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.getSettings.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const loading = useUiStore.getState().load();
    // The user flips a switch while the read is still in flight.
    useUiStore.getState().setLayerVisible("labels", true);
    // Nothing is written before the saved file is read.
    await flush();
    expect(api.setSettings).not.toHaveBeenCalled();

    answer({ theme: "light", layers: { rings: false, labels: false }, collapsed: {} });
    await loading;
    await flush();
    expect(useUiStore.getState().layers).toEqual({ rings: false, labels: true });
    expect(api.setSettings).toHaveBeenLastCalledWith("preferences.ui", {
      theme: "light",
      layers: { rings: false, labels: true },
      collapsed: {},
      consents: {}
    });
  });

  it("writes a notice accepted while the saved file loads before whenSaved resolves", async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.getSettings.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const loading = useUiStore.getState().load();
    useUiStore.getState().setLayerVisible("submarine-cables", true);
    useUiStore.getState().acceptConsent();
    let saved = false;
    const written = useUiStore
      .getState()
      .whenSaved()
      .then(() => (saved = true));
    await flush();
    // The backend would refuse now: nothing is written yet, so whenSaved waits.
    expect(saved).toBe(false);
    expect(api.setSettings).not.toHaveBeenCalled();

    answer({ theme: "dark", layers: {}, collapsed: {} });
    await loading;
    await written;
    expect(api.setSettings).toHaveBeenLastCalledWith("preferences.ui", {
      theme: "dark",
      layers: { "submarine-cables": true },
      collapsed: {},
      consents: { "submarine-cables": true }
    });
  });

  it("uses the defaults but saves nothing when the settings cannot be read", async () => {
    api.getSettings.mockRejectedValue(new Error("no app data folder"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await useUiStore.getState().load();
    expect(useUiStore.getState().loaded).toBe(false);
    expect(selectTheme(useUiStore.getState())).toBe("dark");
    expect(useNoticeStore.getState().notice).toEqual({
      text: "Could not read the saved layout and layer choices (no app data folder); changes in this session are not saved.",
      tone: "error"
    });
    // A write now would replace the saved choices with the defaults.
    useUiStore.getState().setTheme("light");
    await flush();
    expect(selectTheme(useUiStore.getState())).toBe("light");
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("says when a choice could not be saved", async () => {
    await useUiStore.getState().load();
    api.setSettings.mockRejectedValue("Invalid UI preferences: disk full");
    useUiStore.getState().setTheme("light");
    await flush();
    await flush();
    expect(useNoticeStore.getState().notice).toEqual({
      text: "Could not save the layout and layer choices: Invalid UI preferences: disk full",
      tone: "error"
    });
  });
});
