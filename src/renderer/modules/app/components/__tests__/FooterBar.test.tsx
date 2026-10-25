import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RendererApi } from "@common/bridge";
import type { TracerouteRun } from "@common/ipc";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useNoticeStore } from "@renderer/state/noticeStore";
import type { ExportOptions } from "../../lib/exportCapture";
import { FooterBar } from "../FooterBar";

const exports = vi.hoisted(() => ({
  pending: [] as Array<{ options: ExportOptions; resolve: (filename: string) => void }>
}));

vi.mock("../../lib/exportCapture", () => ({
  runExport: (options: ExportOptions) =>
    new Promise<{ filename: string }>((resolve) => {
      exports.pending.push({ options, resolve: (filename) => resolve({ filename }) });
    })
}));

const run: TracerouteRun = {
  request: {
    target: "example.com",
    protocol: "ICMP",
    maxHops: 30,
    timeoutMs: 4000,
    packetCount: 3,
    forceFresh: false
  },
  summary: { target: "example.com", startedAt: 1, hopCount: 0, protocolsTried: ["ICMP"], notices: [] },
  hops: []
};

const exportButton = () => screen.getByRole("button", { name: /Download export|Exporting/ });

const exportAs = (format: string) => {
  fireEvent.click(exportButton());
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(format, "i") }));
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
};

const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

describe("FooterBar export", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    exports.pending = [];
    useNoticeStore.getState().clear();
    window.visTracer = {
      getGeoDatabaseMeta: vi.fn().mockResolvedValue({ cityDbStatus: "loaded", asnDbStatus: "loaded" })
    } as unknown as RendererApi;
    useTracerouteStore.setState({ runs: { r1: run }, currentRunId: "r1" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FooterBar />
      </QueryClientProvider>
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let a finished export's reset timer end the next export", async () => {
    exportAs("PNG");
    await act(async () => exports.pending[0].resolve("vistracer-snapshot-a.png"));
    expect(screen.getByRole("status").textContent).toBe("Saved vistracer-snapshot-a.png");

    // A second export starts 2 s later, before the first one's 3.5 s timer.
    await advance(2000);
    exportAs("WebM");
    expect(exports.pending[1].options.format).toBe("webm");
    expect(screen.queryByRole("status")).toBeNull();

    // The first export's timer would have reset the button here.
    await advance(2000);
    expect(exportButton().textContent).toBe("Exporting…");
    expect((exportButton() as HTMLButtonElement).disabled).toBe(true);

    await act(async () => exports.pending[1].resolve("vistracer-route-b.webm"));
    expect(exportButton().textContent).toBe("Download export");
    await advance(3000);
    expect(screen.getByRole("status").textContent).toBe("Saved vistracer-route-b.webm");
    await advance(600);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
