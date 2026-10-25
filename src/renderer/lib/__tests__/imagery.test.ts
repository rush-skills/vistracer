import { describe, expect, it } from "vitest";
import {
  BUNDLED_IMAGERY,
  ONLINE_IMAGERY,
  OnlineImageryGate,
  bundledOnlyHeight,
  nightImageryShare,
  onlineTileTemplate
} from "@renderer/lib/imagery";

describe("onlineTileTemplate", () => {
  it("uses the tile scheme form of each platform", () => {
    const mac = (path: string, protocol: string) => `${protocol}://localhost/${path}`;
    const windows = (path: string, protocol: string) => `http://${protocol}.localhost/${path}`;
    expect(onlineTileTemplate(mac)).toBe("vistiles://localhost/blue-marble/{z}/{y}/{x}.jpg");
    expect(onlineTileTemplate(windows)).toBe(
      "http://vistiles.localhost/blue-marble/{z}/{y}/{x}.jpg"
    );
  });

  it("has no online layer outside the desktop app", () => {
    expect(onlineTileTemplate(undefined)).toBeNull();
  });

  it("starts online tiles where the bundled levels end", () => {
    expect(ONLINE_IMAGERY.minimumTerrainLevel).toBe(BUNDLED_IMAGERY.maximumLevel + 1);
  });
});

describe("nightImageryShare", () => {
  // Cesium's defaults for the WGS84 ellipsoid: π/2 and π times the polar radius.
  const fadeOut = (Math.PI / 2) * 6_356_752;
  const fadeIn = Math.PI * 6_356_752;

  it("shows city lights far out and the day imagery close up", () => {
    expect(nightImageryShare(6_371_000 + 14_000_000, fadeOut, fadeIn)).toBe(1);
    expect(nightImageryShare(6_371_000 + 2_000_000, fadeOut, fadeIn)).toBe(0);
    expect(nightImageryShare((fadeOut + fadeIn) / 2, fadeOut, fadeIn)).toBeCloseTo(0.5, 10);
  });

  it("keeps the night imagery when the fade range is empty", () => {
    expect(nightImageryShare(1, 5, 5)).toBe(1);
  });
});

describe("bundledOnlyHeight", () => {
  const view = {
    levelGeometricErrorM: 4_892,
    viewportPx: 1000,
    fovRad: Math.PI / 3,
    maximumScreenSpaceError: 2
  };

  it("rises with the size of the view and falls with the allowed error", () => {
    const base = bundledOnlyHeight(view);
    expect(bundledOnlyHeight({ ...view, viewportPx: 2000 })).toBeCloseTo(2 * base, 6);
    expect(bundledOnlyHeight({ ...view, maximumScreenSpaceError: 4 })).toBeCloseTo(base / 2, 6);
  });

  it("adds a margin above Cesium's refinement threshold", () => {
    const threshold = (4_892 * 1000) / (2 * 2 * Math.tan(Math.PI / 6));
    expect(bundledOnlyHeight(view)).toBeGreaterThan(threshold);
    expect(bundledOnlyHeight(view)).toBeLessThan(threshold * 1.2);
  });
});

describe("OnlineImageryGate", () => {
  it("lets the user's own view load online tiles before any app move", () => {
    const gate = new OnlineImageryGate();
    expect(gate.visible).toBe(true);
    expect(gate.userMovedCamera()).toBe(false);
    expect(gate.visible).toBe(true);
  });

  it("keeps online tiles off after an app move until the user moves the camera", () => {
    const gate = new OnlineImageryGate();
    gate.appFlightStarted();
    expect(gate.visible).toBe(false);
    gate.appFlightEnded();
    // The view the app chose stays on bundled tiles, also when the window
    // grows later (a larger monitor raises the screen-space error).
    expect(gate.visible).toBe(false);
    expect(gate.userMovedCamera()).toBe(true);
    expect(gate.visible).toBe(true);
  });

  it("ignores input that Cesium ignores: during a flight and while input is locked", () => {
    const gate = new OnlineImageryGate();
    gate.appFlightStarted();
    expect(gate.userMovedCamera()).toBe(false);
    gate.appFlightEnded();
    gate.setInputLocked(true);
    expect(gate.userMovedCamera()).toBe(false);
    expect(gate.visible).toBe(false);
    gate.setInputLocked(false);
    expect(gate.userMovedCamera()).toBe(true);
    expect(gate.visible).toBe(true);
  });

  it("hides the layer again for the next app move", () => {
    const gate = new OnlineImageryGate();
    gate.appFlightStarted();
    gate.appFlightEnded();
    gate.userMovedCamera();
    gate.appFlightStarted();
    expect(gate.visible).toBe(false);
  });
});
