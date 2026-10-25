import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { RendererApi } from "@common/bridge";
import { LAYERS } from "@renderer/lib/layers";
import { useInfraStore } from "@renderer/state/infraStore";
import { useUiStore } from "@renderer/state/uiStore";
import { LayerConsentDialog } from "../LayerConsentDialog";
import { LayerPanel } from "../LayerPanel";
import { Toolbar } from "../Toolbar";

const initial = useUiStore.getState();
const initialInfra = useInfraStore.getState();
let setSettings: ReturnType<typeof vi.fn>;

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(async () => {
  setSettings = vi.fn().mockResolvedValue(undefined);
  window.visTracer = {
    getSettings: vi.fn().mockResolvedValue(undefined),
    setSettings
  } as unknown as RendererApi;
  useUiStore.setState(initial, true);
  useInfraStore.setState(initialInfra, true);
  await useUiStore.getState().load();
});

const renderPanel = () =>
  render(
    <div>
      <Toolbar />
      <LayerPanel />
      <LayerConsentDialog />
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
      collapsed: { layers: false },
      consents: {}
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

  it("groups the infrastructure and cloud switches, with provider switches under cloud regions", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    const infra = screen.getByRole("group", { name: "Infrastructure" });
    for (const name of ["Internet exchanges", "Data centres", "Submarine cables"]) {
      expect((within(infra).getByRole("switch", { name }) as HTMLInputElement).checked).toBe(false);
    }
    const cloud = screen.getByRole("group", { name: "Cloud" });
    const aws = within(cloud).getByRole("switch", { name: "AWS" }) as HTMLInputElement;
    expect(aws.checked).toBe(true);
    expect(aws.closest(".layer-panel__item--child")).toBeTruthy();
    expect(screen.getByText(/Amazon Web Services regions\. Turn on Cloud regions to see it\./)).toBeTruthy();
    fireEvent.click(within(cloud).getByRole("switch", { name: "Cloud regions" }));
    expect(screen.queryByText(/Turn on Cloud regions to see it/)).toBeNull();
  });

  it("says why a layer shows nothing yet", () => {
    useUiStore.setState({ layers: { exchanges: true } });
    act(() =>
      useInfraStore.setState({
        sources: {
          ...useInfraStore.getState().sources,
          "peeringdb-sites": { status: "unavailable", message: "No exchange list yet." }
        }
      })
    );
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    // Both layers use the list; each says so under its switch.
    expect(screen.getAllByText("No exchange list yet.")).toHaveLength(1);
    act(() => useUiStore.getState().setLayerVisible("data-centres", true));
    expect(screen.getAllByText("No exchange list yet.")).toHaveLength(2);
  });

  it("asks before it shows the submarine cables, once", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    const cables = () => screen.getByRole("switch", { name: "Submarine cables" }) as HTMLInputElement;
    fireEvent.click(cables());
    const notice = screen.getByRole("dialog", { name: "Show submarine cables?" });
    expect(notice.textContent).toContain("CC BY-NC-SA 3.0");
    expect(notice.textContent).toContain("www.submarinecablemap.com");
    expect(cables().checked).toBe(false);

    fireEvent.click(within(notice).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cables().checked).toBe(false);

    fireEvent.click(cables());
    fireEvent.click(screen.getByRole("button", { name: "Show and download" }));
    await flush();
    expect(cables().checked).toBe(true);
    expect(setSettings).toHaveBeenLastCalledWith(
      "preferences.ui",
      expect.objectContaining({
        layers: { "submarine-cables": true },
        consents: { "submarine-cables": true }
      })
    );

    fireEvent.click(cables());
    fireEvent.click(cables());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cables().checked).toBe(true);
  });

  it("puts the satellite groups under Satellites, behind a notice that names celestrak.org", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    const space = screen.getByRole("group", { name: "Space" });
    const satellites = () =>
      within(space).getByRole("switch", { name: "Satellites" }) as HTMLInputElement;
    const starlink = within(space).getByRole("switch", { name: "Starlink" }) as HTMLInputElement;
    expect(satellites().checked).toBe(false);
    // Group switches show their own default and need the parent.
    expect(starlink.checked).toBe(true);
    expect(within(space).getAllByText(/Turn on Satellites to see it/)).toHaveLength(5);
    expect((within(space).getByRole("switch", { name: "Geostationary" }) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(satellites());
    const notice = screen.getByRole("dialog", { name: "Show satellites?" });
    expect(notice.textContent).toContain("celestrak.org");
    expect(notice.textContent).toContain("usage policy");
    expect(satellites().checked).toBe(false);
    fireEvent.click(within(notice).getByRole("button", { name: "Show and download" }));
    await flush();
    expect(satellites().checked).toBe(true);
    expect(setSettings).toHaveBeenLastCalledWith(
      "preferences.ui",
      expect.objectContaining({ layers: { satellites: true }, consents: { satellites: true } })
    );

    // The group's data status shows under its switch.
    act(() =>
      useInfraStore.setState({
        sources: {
          ...useInfraStore.getState().sources,
          "celestrak-starlink": { status: "loading" }
        }
      })
    );
    expect(within(space).getAllByRole("status").map((status) => status.textContent)).toContain(
      "Loading…"
    );
  });
});
