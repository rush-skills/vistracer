import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { RendererApi } from "@common/bridge";
import { LAYERS } from "@renderer/lib/layers";
import { useUiStore } from "@renderer/state/uiStore";
import { LayerPanel } from "../LayerPanel";
import { Toolbar } from "../Toolbar";

const initial = useUiStore.getState();
let setSettings: ReturnType<typeof vi.fn>;

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(async () => {
  setSettings = vi.fn().mockResolvedValue(undefined);
  window.visTracer = {
    getSettings: vi.fn().mockResolvedValue(undefined),
    setSettings
  } as unknown as RendererApi;
  useUiStore.setState(initial, true);
  await useUiStore.getState().load();
});

const renderPanel = () =>
  render(
    <div>
      <Toolbar />
      <LayerPanel />
    </div>
  );

describe("LayerPanel", () => {
  it("opens from the toolbar and lists one switch per registry entry, by group", () => {
    renderPanel();
    const toggle = screen.getByRole("button", { name: "Layers" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("region", { name: "Layers" });
    expect(within(panel).getAllByRole("switch")).toHaveLength(LAYERS.length);
    const route = within(panel).getByRole("group", { name: "Route" });
    expect(within(route).getByRole("switch", { name: "Confidence rings" })).toBeTruthy();
    const globe = within(panel).getByRole("group", { name: "Globe" });
    const online = within(globe).getByRole("switch", { name: "Online imagery" });
    expect((online as HTMLInputElement).checked).toBe(true);
    expect(online.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(/Off: only the bundled imagery, nothing is downloaded/)).toBeTruthy();
  });

  it("switches online imagery off and saves it, so the tile cache downloads nothing", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    fireEvent.click(screen.getByRole("switch", { name: "Online imagery" }));
    await flush();

    expect((screen.getByRole("switch", { name: "Online imagery" }) as HTMLInputElement).checked).toBe(
      false
    );
    expect(setSettings).toHaveBeenLastCalledWith("preferences.ui", {
      theme: "dark",
      layers: { "online-imagery": false },
      collapsed: { layers: false }
    });
  });

  it("closes with Escape and returns focus to the toolbar button", () => {
    renderPanel();
    const toggle = screen.getByRole("button", { name: "Layers" });
    fireEvent.click(toggle);
    const rings = screen.getByRole("switch", { name: "Confidence rings" });
    rings.focus();
    fireEvent.keyDown(rings, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});
