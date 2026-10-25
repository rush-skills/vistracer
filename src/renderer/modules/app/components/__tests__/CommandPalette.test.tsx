import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RendererApi } from "@common/bridge";
import { ROUTE, makeRun } from "@renderer/test/fixtures";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";
import { UI_EVENTS, type StartTraceDetail } from "../../lib/uiEvents";
import { CommandPalette } from "../CommandPalette";

const initialUi = useUiStore.getState();

const setPlatform = (value: string) =>
  Object.defineProperty(navigator, "platform", { value, configurable: true });

const pressShortcut = (init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, ...init }));
  });

const input = () => screen.getByRole("combobox");
const options = () => screen.getAllByRole("option");
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const key = (name: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(input(), { key: name, ...init });

beforeEach(async () => {
  setPlatform("Linux x86_64");
  window.visTracer = {
    getSettings: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined)
  } as unknown as RendererApi;
  useUiStore.setState(initialUi, true);
  await useUiStore.getState().load();
  useTracerouteStore.setState({
    runs: { r1: makeRun(ROUTE) },
    currentRunId: "r1",
    status: "success",
    selectedHopIndex: undefined
  });
  render(
    <div>
      <button type="button">Before</button>
      <CommandPalette />
    </div>
  );
});

afterEach(() => {
  // Back to the prototype's getter.
  delete (navigator as { platform?: string }).platform;
});

describe("CommandPalette", () => {
  it("opens with Ctrl+K, closes with Escape and gives the focus back", () => {
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    pressShortcut({ ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Command bar" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(input());

    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("stays open while the shortcut is held and its key repeats", () => {
    pressShortcut({ ctrlKey: true });
    pressShortcut({ ctrlKey: true, repeat: true });
    pressShortcut({ ctrlKey: true, repeat: true });
    expect(screen.getByRole("dialog", { name: "Command bar" })).toBeTruthy();
  });

  it("uses ⌘K on macOS and ignores Ctrl+K there", () => {
    setPlatform("MacIntel");
    pressShortcut({ ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    pressShortcut({ metaKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    pressShortcut({ metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a combobox over a listbox whose active option follows the arrow keys", () => {
    pressShortcut({ ctrlKey: true });
    const list = screen.getByRole("listbox", { name: "Commands" });
    expect(input().getAttribute("aria-controls")).toBe(list.id);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    const first = options()[0];
    expect(input().getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.getAttribute("aria-selected")).toBe("true");

    key("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1].id);
    key("ArrowUp");
    key("ArrowUp");
    // Wraps to the last command.
    expect(input().getAttribute("aria-activedescendant")).toBe(options().at(-1)?.id);
  });

  it("finds a command by a loose query and runs it with Enter", () => {
    pressShortcut({ ctrlKey: true });
    type("lght thm");
    expect(options()[0].textContent).toContain("Switch to the light theme");
    key("Enter");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useUiStore.getState().theme).toBe("light");

    pressShortcut({ ctrlKey: true });
    type("hop 5");
    expect(options()[0].textContent).toContain("Go to hop 5");
    fireEvent.click(options()[0]);
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(5);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("toggles a layer from the bar", () => {
    pressShortcut({ ctrlKey: true });
    type("online imagery");
    expect(options()[0].textContent).toContain("Hide online imagery");
    key("Enter");
    expect(useUiStore.getState().layers).toEqual({ "online-imagery": false });
  });

  it("lists a command that cannot run with the reason, and does not run it", () => {
    useTracerouteStore.setState({ currentRunId: undefined });
    pressShortcut({ ctrlKey: true });
    type("png");
    const png = options()[0];
    expect(png.textContent).toContain("Export a PNG snapshot");
    expect(png.textContent).toContain("Trace a host first.");
    expect(png.getAttribute("aria-disabled")).toBe("true");
    key("Enter");
    fireEvent.click(png);
    // Still open: nothing ran.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("starts a trace to a typed host", () => {
    const started: string[] = [];
    const listener = (event: Event) =>
      started.push((event as CustomEvent<StartTraceDetail>).detail.target);
    window.addEventListener(UI_EVENTS.START_TRACE, listener);
    try {
      pressShortcut({ ctrlKey: true });
      type("example.org");
      expect(options()[0].textContent).toContain("Trace example.org");
      key("Enter");
      expect(started).toEqual(["example.org"]);
    } finally {
      window.removeEventListener(UI_EVENTS.START_TRACE, listener);
    }
  });

  it("keeps the focus inside while open", () => {
    pressShortcut({ ctrlKey: true });
    // fireEvent returns false when the handler prevented the default move.
    expect(key("Tab")).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(key("Tab", { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(input());
  });

  it("keeps the focus in the search field when a press lands elsewhere in the bar", () => {
    useTracerouteStore.setState({ currentRunId: undefined });
    pressShortcut({ ctrlKey: true });
    type("png");
    const disabled = options()[0];
    // A press on an option or the key hints would otherwise blur the field,
    // and Escape and the arrows would stop working.
    expect(fireEvent.mouseDown(disabled)).toBe(false);
    expect(fireEvent.mouseDown(screen.getByText("move"))).toBe(false);
    expect(fireEvent.mouseDown(input())).toBe(true);
    key("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when nothing matches", () => {
    pressShortcut({ ctrlKey: true });
    type("qqqqq");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().hasAttribute("aria-controls")).toBe(false);
    expect(screen.getByText("No command matches “qqqqq”.")).toBeTruthy();
  });

  it("does not open over another dialog", () => {
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-modal", "true");
    document.body.append(other);
    try {
      pressShortcut({ ctrlKey: true });
      expect(screen.queryByRole("dialog", { name: "Command bar" })).toBeNull();
    } finally {
      other.remove();
    }
  });
});
