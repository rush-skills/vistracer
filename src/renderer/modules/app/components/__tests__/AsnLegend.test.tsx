import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { ASN_PALETTE, UNKNOWN_ASN_COLOR } from "@renderer/lib/infra/asnColors";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";
import { ROUTE, makeRun } from "@renderer/test/fixtures";
import { AsnLegend } from "../AsnLegend";
import { FooterBar } from "../FooterBar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

beforeEach(() => {
  useUiStore.setState({ layers: {} });
  useTracerouteStore.setState({ runs: { r1: makeRun(ROUTE) }, currentRunId: "r1" });
});

describe("AsnLegend", () => {
  it("lists the networks of the route while network colours are on", () => {
    render(<AsnLegend />);
    expect(screen.queryByRole("region", { name: "Networks on the route" })).toBeNull();

    act(() => useUiStore.setState({ layers: { "asn-colors": true } }));
    const legend = screen.getByRole("region", { name: "Networks on the route" });
    const items = within(legend).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "AS6453 TATA COMMUNICATIONShop 3",
      "AS15169 GOOGLEhop 6",
      "No network datahops 1, 2, 5"
    ]);
    const swatch = (item: HTMLElement) =>
      (item.querySelector(".asn-legend__swatch") as HTMLElement).style.background;
    expect(swatch(items[2])).toBe(hexToRgb(UNKNOWN_ASN_COLOR));
    expect(ASN_PALETTE.map(hexToRgb)).toContain(swatch(items[0]));
  });

  it("switches the status bar legend from latency to networks", () => {
    window.visTracer = {
      getGeoDatabaseMeta: async () => ({ cityDbStatus: "loaded", asnDbStatus: "loaded" })
    } as unknown as typeof window.visTracer;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FooterBar />
      </QueryClientProvider>
    );
    expect(screen.getByRole("list", { name: "Arc colour: round-trip time" })).toBeTruthy();
    act(() => useUiStore.setState({ layers: { "asn-colors": true } }));
    expect(screen.queryByRole("list", { name: "Arc colour: round-trip time" })).toBeNull();
    expect(screen.getByText("Arc colour: network (ASN), see the legend")).toBeTruthy();
  });
});

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
