import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { useUpdateStore } from "@renderer/state/updateStore";
import { UpdateBanner } from "../UpdateBanner";

describe("UpdateBanner", () => {
  beforeEach(() => {
    useUpdateStore.setState({ status: { kind: "idle" }, dismissed: false });
  });

  it("stays hidden for background states, including failed checks", () => {
    for (const status of [
      { kind: "idle" as const },
      { kind: "up-to-date" as const },
      { kind: "disabled" as const, reason: "no key" },
      { kind: "error" as const, message: "offline" }
    ]) {
      useUpdateStore.setState({ status });
      const { container, unmount } = render(<UpdateBanner />);
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  it("offers an available update and can be dismissed", () => {
    useUpdateStore.setState({ status: { kind: "available", version: "1.1.0" } });
    render(<UpdateBanner />);
    expect(screen.getByText("VisTracer 1.1.0 is available.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install and restart" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText("VisTracer 1.1.0 is available.")).toBeNull();
  });

  it("shows install failures", () => {
    useUpdateStore.setState({
      status: { kind: "install-failed", version: "1.1.0", message: "signature verification failed" }
    });
    render(<UpdateBanner />);
    expect(screen.getByRole("alert").textContent).toContain("signature verification failed");
  });
});
