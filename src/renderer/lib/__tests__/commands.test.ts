import { describe, expect, it, vi } from "vitest";
import { ROUTE, makeRun } from "@renderer/test/fixtures";
import {
  buildCommands,
  fuzzyScore,
  isValidTarget,
  searchCommands,
  traceCommand,
  type CommandActions,
  type CommandContext
} from "../commands";
import { LAYERS, layerVisibility } from "../layers";
import { isCommandBarShortcut } from "../shortcuts";

const actions = (): CommandActions => ({
  startTrace: vi.fn(),
  rerun: vi.fn(),
  cancelTrace: vi.fn(),
  selectHop: vi.fn(),
  setLayerVisible: vi.fn(),
  setTheme: vi.fn(),
  setPanelCollapsed: vi.fn(),
  openSettings: vi.fn(),
  showGuide: vi.fn(),
  exportAs: vi.fn(),
  openExportDialog: vi.fn(),
  clearTileCache: vi.fn()
});

const context = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  running: false,
  run: makeRun(ROUTE),
  layers: layerVisibility({}),
  theme: "dark",
  collapsed: { "trace-options": true, hops: false, timeline: false, layers: true },
  exporting: false,
  actions: actions(),
  ...overrides
});

const byId = (ctx: CommandContext, id: string) => {
  const command = buildCommands(ctx).find((candidate) => candidate.id === id);
  if (!command) throw new Error(`no ${id}`);
  return command;
};

describe("buildCommands", () => {
  it("has a command for every hop, every layer, the theme, each panel, exports and settings", () => {
    const ids = buildCommands(context()).map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "trace.rerun",
        ...ROUTE.map((hop) => `hop.${hop.hopIndex}`),
        ...LAYERS.map((layer) => `layer.${layer.id}`),
        "view.theme",
        "panel.hops",
        "panel.timeline",
        "panel.layers",
        "panel.trace-options",
        "export.png",
        "export.webm",
        "export.gif",
        "export.dialog",
        "settings.open",
        "settings.clear-tiles",
        "help.guide"
      ])
    );
  });

  it("names each toggle after what it will do and runs it", () => {
    const ctx = context({ layers: layerVisibility({ rings: false }) });
    const rings = byId(ctx, "layer.rings");
    expect(rings.title).toBe("Show confidence rings");
    rings.run();
    expect(ctx.actions.setLayerVisible).toHaveBeenCalledWith("rings", true);
    expect(byId(ctx, "layer.online-imagery").title).toBe("Hide online imagery");

    const theme = byId(ctx, "view.theme");
    expect(theme.title).toBe("Switch to the light theme");
    theme.run();
    expect(ctx.actions.setTheme).toHaveBeenCalledWith("light");
    expect(byId(context({ theme: "light" }), "view.theme").title).toBe("Switch to the dark theme");

    expect(byId(ctx, "panel.layers").title).toBe("Show layers");
    expect(byId(ctx, "panel.hops").title).toBe("Hide hop details");
  });

  it("goes to a hop, found by its address, host name or network", () => {
    const ctx = context();
    const hop = byId(ctx, "hop.3");
    expect(hop.title).toBe("Go to hop 3");
    expect(hop.detail).toBe("180.87.38.5, Chennai, India");
    hop.run();
    expect(ctx.actions.selectHop).toHaveBeenCalledWith(3);
    expect(searchCommands(buildCommands(ctx), "tata")[0].id).toBe("hop.3");
    expect(byId(ctx, "hop.6").detail).toBe("8.8.8.8, anycast");
  });

  it("says why a command cannot run", () => {
    const noRun = context({ run: undefined });
    expect(byId(noRun, "export.png").disabledReason).toBe("Trace a host first.");
    expect(byId(noRun, "trace.rerun").disabledReason).toBe("Trace a host first.");
    expect(buildCommands(noRun).some((command) => command.id.startsWith("hop."))).toBe(false);

    const running = context({ running: true });
    expect(byId(running, "trace.rerun").disabledReason).toBe("A trace is running.");
    expect(byId(running, "trace.cancel").disabledReason).toBeUndefined();
    expect(byId(context({ exporting: true }), "export.gif").disabledReason).toBe(
      "An export is running."
    );

    const ctx = context();
    const rerun = byId(ctx, "trace.rerun");
    expect(rerun.detail).toBe("example.com (ICMP)");
    rerun.run();
    expect(ctx.actions.rerun).toHaveBeenCalledWith(ctx.run?.request);
  });
});

describe("traceCommand", () => {
  it("offers a trace for a host, an IP address, or 'trace' and a target", () => {
    const ctx = context();
    expect(traceCommand("example.org", ctx)?.title).toBe("Trace example.org");
    expect(traceCommand("2001:db8::1", ctx)?.title).toBe("Trace 2001:db8::1");
    expect(traceCommand("trace localhost", ctx)?.title).toBe("Trace localhost");
    traceCommand("1.1.1.1", ctx)?.run();
    expect(ctx.actions.startTrace).toHaveBeenCalledWith("1.1.1.1");
  });

  it("does not take a search word or an invalid target for a host", () => {
    const ctx = context();
    expect(traceCommand("layers", ctx)).toBeNull();
    expect(traceCommand("", ctx)).toBeNull();
    expect(traceCommand("example.com; rm -rf /", ctx)).toBeNull();
    expect(traceCommand("trace -e/bin/sh", ctx)).toBeNull();
    expect(isValidTarget("-x.example")).toBe(false);
    expect(traceCommand("example.org", context({ running: true }))?.disabledReason).toBe(
      "A trace is running."
    );
  });
});

describe("fuzzy search", () => {
  it("matches letters in order and prefers runs of letters and word starts", () => {
    expect(fuzzyScore("xyz", "Open settings")).toBeNull();
    const words = fuzzyScore("os", "Open settings") ?? 0;
    const scattered = fuzzyScore("os", "Hide hop details") ?? 0;
    expect(words).toBeGreaterThan(scattered);
    expect(fuzzyScore("set", "Open settings")).toBeGreaterThan(words);
  });

  it("ranks the closest title first and keeps all commands for an empty query", () => {
    const commands = buildCommands(context());
    expect(searchCommands(commands, "")).toEqual(commands);
    expect(searchCommands(commands, "light")[0].id).toBe("view.theme");
    expect(searchCommands(commands, "gif")[0].id).toBe("export.gif");
    expect(searchCommands(commands, "rings")[0].id).toBe("layer.rings");
    expect(searchCommands(commands, "clr tile")[0].id).toBe("settings.clear-tiles");
    expect(searchCommands(commands, "qqqq")).toEqual([]);
  });
});

describe("command bar shortcut", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { key: "k", ...init });

  it("is ⌘K on macOS and Ctrl+K elsewhere", () => {
    expect(isCommandBarShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isCommandBarShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isCommandBarShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isCommandBarShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isCommandBarShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isCommandBarShortcut(new KeyboardEvent("keydown", { key: "j", ctrlKey: true }), false)).toBe(
      false
    );
  });
});
