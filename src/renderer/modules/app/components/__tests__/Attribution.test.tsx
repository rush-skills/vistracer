import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useUiStore } from "@renderer/state/uiStore";
import { CREDITS } from "@renderer/lib/attribution";
import { Attribution } from "../Attribution";

beforeEach(() => {
  useUiStore.setState({ layers: {} });
});

describe("Attribution", () => {
  it("is a small button that opens the full list of sources", () => {
    render(<Attribution />);
    const toggle = screen.getByRole("button", { name: "Data sources and credits" });
    expect(toggle.textContent).toBe("NASA, GIBS, CesiumJS");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    const panel = screen.getByRole("dialog", { name: "Data sources and credits" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close credits" }));
    for (const credit of CREDITS) {
      expect(within(panel).getByText(credit.name)).toBeTruthy();
    }
    const globe = within(panel).getByRole("region", { name: "Globe" });
    expect(globe.textContent).toContain("Apache-2.0");
    expect(globe.textContent).toContain(
      "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS)"
    );
    expect(panel.textContent).toContain(
      "This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com."
    );

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("credits GIBS with its acknowledgement also while online imagery is off", () => {
    // The bundled day and night tiles come from GIBS too
    // (scripts/build-globe-imagery.mjs), so the credit never goes away.
    const gibs = () => screen.getByText("NASA GIBS").closest("li");
    render(<Attribution />);
    const toggle = screen.getByRole("button", { name: "Data sources and credits" });
    fireEvent.click(toggle);
    expect(gibs()?.textContent).toContain("Served the bundled day and night tiles");
    expect(gibs()?.textContent).not.toContain("Online tiles: off.");

    act(() => useUiStore.setState({ layers: { "online-imagery": false } }));
    expect(toggle.textContent).toBe("NASA, GIBS, CesiumJS");
    expect(gibs()?.textContent).toContain("Served the bundled day and night tiles");
    expect(gibs()?.textContent).toContain("Online tiles: off.");
    expect(gibs()?.textContent).toContain(
      "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS)"
    );
    expect(screen.getByRole("dialog").textContent).not.toContain("Not used");
  });
});
