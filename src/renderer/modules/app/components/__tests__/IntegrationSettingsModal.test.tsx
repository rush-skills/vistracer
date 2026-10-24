import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IntegrationSettings, TileCacheInfo } from "@common/ipc";
import type { RendererApi } from "@common/bridge";
import {
  IntegrationSettingsModal,
  buildIntegrationSettings,
  type IntegrationSettingsFormState
} from "../IntegrationSettingsModal";

const savedSettings: IntegrationSettings = {
  teamCymru: { enabled: true },
  rdap: { enabled: true, baseUrl: "https://rdap.org/ip" },
  ripeStat: { enabled: true, sourceApp: "VisTracer" },
  peeringDb: { enabled: false },
  ixMatching: { enabled: true }
};

/** Renders the modal and lets the tile cache section finish loading. */
const renderModal = async (settings: IntegrationSettings = savedSettings) => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onGeoSave = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  await act(async () => {
    render(
      <IntegrationSettingsModal
        isOpen
        settings={settings}
        geoLoading={false}
        onClose={onClose}
        onSave={onSave}
        onGeoSave={onGeoSave}
      />
    );
  });
  return { onSave, onGeoSave, onClose };
};

const CAP = 500_000_000;
let tileCache: { getTileCacheInfo: ReturnType<typeof vi.fn>; clearTileCache: ReturnType<typeof vi.fn> };

beforeEach(() => {
  tileCache = {
    getTileCacheInfo: vi
      .fn<() => Promise<TileCacheInfo>>()
      .mockResolvedValue({ sizeBytes: 48_700_000, tileCount: 2_311, capBytes: CAP }),
    clearTileCache: vi
      .fn<() => Promise<TileCacheInfo>>()
      .mockResolvedValue({ sizeBytes: 0, tileCount: 0, capBytes: CAP })
  };
  window.visTracer = tileCache as unknown as RendererApi;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("IntegrationSettingsModal providers", () => {
  it("shows one toggle per provider that reflects the saved settings", async () => {
    await renderModal();
    expect(checkbox("Team Cymru").checked).toBe(true);
    expect(checkbox("RDAP").checked).toBe(true);
    expect(checkbox("RIPEstat").checked).toBe(true);
    expect(checkbox("PeeringDB").checked).toBe(false);
    expect(checkbox("Internet exchanges").checked).toBe(true);
    expect(
      screen.getByText(
        "Match hops to internet exchanges. Downloads PeeringDB's public exchange list once a day; nothing about your route is sent."
      )
    ).toBeTruthy();
    expect(input("PeeringDB API key").type).toBe("password");
    // The exchange list download uses the key too, so it stays editable
    // while either switch is on.
    expect(input("PeeringDB API key").disabled).toBe(false);
    fireEvent.click(checkbox("Internet exchanges"));
    expect(input("PeeringDB API key").disabled).toBe(true);
  });

  it("saves provider toggles and a trimmed PeeringDB API key", async () => {
    const { onSave, onClose } = await renderModal();

    fireEvent.click(checkbox("Team Cymru"));
    fireEvent.click(checkbox("PeeringDB"));
    expect(input("PeeringDB API key").disabled).toBe(false);
    fireEvent.change(input("PeeringDB API key"), { target: { value: "  key-123 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({
      teamCymru: { enabled: false },
      rdap: { enabled: true, baseUrl: "https://rdap.org/ip" },
      ripeStat: { enabled: true, sourceApp: "VisTracer" },
      peeringDb: { enabled: true, apiKey: "key-123" },
      ixMatching: { enabled: true }
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("saves exchange matching separately from PeeringDB", async () => {
    const { onSave, onClose } = await renderModal();
    expect(checkbox("PeeringDB").checked).toBe(false);

    fireEvent.click(checkbox("Internet exchanges"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const saved = onSave.mock.calls[0][0] as IntegrationSettings;
    expect(saved.ixMatching).toEqual({ enabled: false });
    expect(saved.peeringDb.enabled).toBe(false);
  });

  it("loads an existing key and lets the user disable a provider", async () => {
    const { onSave, onClose } = await renderModal({
      ...savedSettings,
      peeringDb: { enabled: true, apiKey: "stored-key" }
    });
    expect(input("PeeringDB API key").value).toBe("stored-key");

    fireEvent.click(checkbox("RIPEstat"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const saved = onSave.mock.calls[0][0] as IntegrationSettings;
    expect(saved.ripeStat.enabled).toBe(false);
    expect(saved.peeringDb).toEqual({ enabled: true, apiKey: "stored-key" });
  });

  it("rejects a non-HTTP RDAP URL and does not save", async () => {
    const { onSave, onClose } = await renderModal();

    fireEvent.change(input("RDAP base URL"), { target: { value: "ftp://rdap.example.net" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("RDAP base URL must start with https:// or http://.")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("IntegrationSettingsModal globe imagery", () => {
  it("shows the tile cache size and clears it", async () => {
    await renderModal();
    expect(await screen.findByText("Tile cache: 49 MB of 500 MB (2,311 tiles).")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear tile cache" }));
    expect(await screen.findByText("Tile cache: Empty (limit 500 MB).")).toBeTruthy();
    expect(tileCache.clearTileCache).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Clear tile cache" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("says why clearing failed and shows the size that is left", async () => {
    tileCache.clearTileCache.mockRejectedValue(
      "Could not clear the tile cache in /cache/tiles: permission denied"
    );
    await renderModal();
    await screen.findByText("Tile cache: 49 MB of 500 MB (2,311 tiles).");

    fireEvent.click(screen.getByRole("button", { name: "Clear tile cache" }));
    expect(
      await screen.findByText("Could not clear the tile cache in /cache/tiles: permission denied")
    ).toBeTruthy();
    expect(tileCache.getTileCacheInfo).toHaveBeenCalledTimes(2);
  });

  it("reports a cache that cannot be read", async () => {
    tileCache.getTileCacheInfo.mockRejectedValue(new Error("no app cache folder"));
    await renderModal();
    expect(await screen.findByText("Tile cache: unknown.")).toBeTruthy();
    expect(screen.getByText("no app cache folder")).toBeTruthy();
  });
});

describe("buildIntegrationSettings", () => {
  const form: IntegrationSettingsFormState = {
    teamCymruEnabled: true,
    rdapEnabled: true,
    rdapBaseUrl: "",
    ripeStatEnabled: true,
    peeringDbEnabled: true,
    peeringDbApiKey: "",
    ixMatchingEnabled: true
  };

  it("uses the default RDAP URL when blank and drops an empty key", () => {
    const result = buildIntegrationSettings(form);
    expect(result).toEqual({
      settings: {
        teamCymru: { enabled: true },
        rdap: { enabled: true, baseUrl: "https://rdap.org/ip" },
        ripeStat: { enabled: true, sourceApp: "VisTracer" },
        peeringDb: { enabled: true, apiKey: undefined },
        ixMatching: { enabled: true }
      }
    });
  });

  it("strips trailing slashes and rejects keys with spaces", () => {
    const custom = buildIntegrationSettings({ ...form, rdapBaseUrl: "https://rdap.example.net/ip//" });
    expect("settings" in custom && custom.settings.rdap.baseUrl).toBe("https://rdap.example.net/ip");
    expect(buildIntegrationSettings({ ...form, peeringDbApiKey: "two words" })).toEqual({
      error: "PeeringDB API key must not contain spaces."
    });
    expect("error" in buildIntegrationSettings({ ...form, rdapBaseUrl: "not a url" })).toBe(true);
  });
});
