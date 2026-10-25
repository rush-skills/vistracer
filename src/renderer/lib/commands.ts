import type { ThemeName, TracerouteRequest, TracerouteRun } from "@common/ipc";
import { hopPosition } from "./globe";
import { LAYERS, type LayerId, type LayerVisibility } from "./layers";
import { PANELS, type PanelId } from "./uiPreferences";

/**
 * Everything the command bar can do, built from the app state. Toolbar and
 * footer buttons run the same commands by id, so a name and its effect are
 * the same wherever the user meets them.
 */

export type CommandGroup = "Trace" | "Hops" | "Layers" | "View" | "Export" | "Settings";

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** Shown after the title, and searched: the target of a trace, a hop's address. */
  detail?: string;
  /** More words the search matches. */
  keywords?: string;
  /** Set when the command cannot run now: says why. */
  disabledReason?: string;
  run: () => void;
}

export type ExportCommandFormat = "png" | "webm" | "gif";

export interface CommandActions {
  startTrace: (target: string) => void;
  rerun: (request: TracerouteRequest) => void;
  cancelTrace: () => void;
  selectHop: (hopIndex: number) => void;
  setLayerVisible: (id: LayerId, visible: boolean) => void;
  setTheme: (theme: ThemeName) => void;
  setPanelCollapsed: (id: PanelId, collapsed: boolean) => void;
  openSettings: () => void;
  showGuide: () => void;
  exportAs: (format: ExportCommandFormat) => void;
  openExportDialog: () => void;
  clearTileCache: () => void;
}

export interface CommandContext {
  running: boolean;
  run?: TracerouteRun;
  layers: LayerVisibility;
  theme: ThemeName;
  collapsed: Record<PanelId, boolean>;
  exporting: boolean;
  actions: CommandActions;
}

const RUNNING = "A trace is running.";
const NO_RUN = "Trace a host first.";

export function buildCommands(ctx: CommandContext): Command[] {
  const { actions, run } = ctx;
  const commands: Command[] = [];

  commands.push({
    id: "trace.rerun",
    title: "Run the last trace again",
    group: "Trace",
    detail: run ? `${run.request.target} (${run.request.protocol})` : undefined,
    keywords: "repeat rerun again",
    disabledReason: !run ? NO_RUN : ctx.running ? RUNNING : undefined,
    run: () => {
      if (run) {
        actions.rerun(run.request);
      }
    }
  });
  if (ctx.running) {
    commands.push({
      id: "trace.cancel",
      title: "Cancel the running trace",
      group: "Trace",
      keywords: "stop abort",
      run: actions.cancelTrace
    });
  }

  for (const hop of run?.hops ?? []) {
    const place = hopPosition(hop)?.label ?? (hop.location.anycast ? "anycast" : undefined);
    commands.push({
      id: `hop.${hop.hopIndex}`,
      title: `Go to hop ${hop.hopIndex}`,
      group: "Hops",
      detail: [hop.ipAddress ?? "no reply", place].filter(Boolean).join(", "),
      keywords: [hop.hostName, hop.asn?.asn != null ? `AS${hop.asn.asn}` : null, hop.asn?.name]
        .filter(Boolean)
        .join(" "),
      run: () => actions.selectHop(hop.hopIndex)
    });
  }

  for (const layer of LAYERS) {
    const visible = ctx.layers[layer.id];
    commands.push({
      id: `layer.${layer.id}`,
      title: `${visible ? "Hide" : "Show"} ${layer.label.toLowerCase()}`,
      group: "Layers",
      keywords: `layer toggle ${layer.description}`,
      run: () => actions.setLayerVisible(layer.id, !visible)
    });
  }

  const nextTheme: ThemeName = ctx.theme === "dark" ? "light" : "dark";
  commands.push({
    id: "view.theme",
    title: `Switch to the ${nextTheme} theme`,
    group: "View",
    keywords: "theme dark light appearance colour color",
    run: () => actions.setTheme(nextTheme)
  });
  for (const id of Object.keys(PANELS) as PanelId[]) {
    const collapsed = ctx.collapsed[id];
    commands.push({
      id: `panel.${id}`,
      title: `${collapsed ? "Show" : "Hide"} ${PANELS[id].label.toLowerCase()}`,
      group: "View",
      keywords: "panel collapse expand",
      run: () => actions.setPanelCollapsed(id, !collapsed)
    });
  }

  const exportBlocked = !run ? NO_RUN : ctx.exporting ? "An export is running." : undefined;
  const exportCommand = (format: ExportCommandFormat, title: string, keywords: string) => ({
    id: `export.${format}`,
    title,
    group: "Export" as const,
    keywords,
    disabledReason: exportBlocked,
    run: () => actions.exportAs(format)
  });
  commands.push(
    exportCommand("png", "Export a PNG snapshot", "image picture save download"),
    exportCommand("webm", "Export a WebM animation", "video movie save download"),
    exportCommand("gif", "Export a GIF animation", "animation save download"),
    {
      id: "export.dialog",
      title: "Export route…",
      group: "Export",
      keywords: "save download format jpg webp",
      disabledReason: exportBlocked,
      run: actions.openExportDialog
    }
  );

  commands.push(
    {
      id: "settings.open",
      title: "Open settings",
      group: "Settings",
      keywords: "preferences integrations providers geolite peeringdb rdap updates",
      run: actions.openSettings
    },
    {
      id: "settings.clear-tiles",
      title: "Clear the tile cache",
      group: "Settings",
      keywords: "imagery gibs disk space delete",
      run: actions.clearTileCache
    },
    {
      id: "help.guide",
      title: "Show the getting started guide",
      group: "Settings",
      keywords: "help onboarding tutorial",
      run: actions.showGuide
    }
  );
  return commands;
}

/** Mirrors `validate_target` in src-tauri/src/commands/traceroute_command.rs. */
export function isValidTarget(target: string): boolean {
  return target.length <= 253 && !target.startsWith("-") && /^[A-Za-z0-9.\-:_%]+$/.test(target);
}

/**
 * "Trace <host>" for a query that names a host: "trace " and a target, or
 * something with a dot or a colon (a domain or an IP address). A bare word
 * like "layers" is a search, not a host.
 */
export function traceCommand(query: string, ctx: CommandContext): Command | null {
  const trimmed = query.trim();
  const prefixed = /^trace\s+(\S+)$/i.exec(trimmed);
  const target = prefixed ? prefixed[1] : /[.:]/.test(trimmed) ? trimmed : "";
  if (!target || !isValidTarget(target)) {
    return null;
  }
  return {
    id: "trace.start",
    title: `Trace ${target}`,
    group: "Trace",
    disabledReason: ctx.running ? RUNNING : undefined,
    run: () => ctx.actions.startTrace(target)
  };
}

const WORD_BREAK = /[\s.,:/-]/;

/**
 * How well `query` matches `text`, case-insensitive; null when it does not.
 * The query as one piece of the text scores highest (more at a word start).
 * Otherwise its letters must appear in order: letters in a row and letters
 * at word starts score more.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const haystack = text.toLowerCase();
  if (!needle) {
    return 0;
  }
  // Shorter texts with the same match are closer matches.
  const lengthPenalty = haystack.length * 0.01;
  const piece = haystack.indexOf(needle);
  if (piece >= 0) {
    const atWord = piece === 0 || WORD_BREAK.test(haystack[piece - 1]);
    return 10 + needle.length * 4 + (atWord ? 4 : 0) - lengthPenalty;
  }
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const letter of needle) {
    const at = haystack.indexOf(letter, from);
    if (at < 0) {
      return null;
    }
    score += 1;
    if (at === previous + 1) {
      score += 3;
    }
    if (at === 0 || WORD_BREAK.test(haystack[at - 1])) {
      score += 2;
    }
    previous = at;
    from = at + 1;
  }
  return score - lengthPenalty;
}

/** Commands that match `query`, best first; all of them, in order, for an empty query. */
export function searchCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) {
    return commands;
  }
  return commands
    .map((command, order) => {
      const title = fuzzyScore(query, command.title);
      const other = fuzzyScore(
        query,
        [command.group, command.detail, command.keywords].filter(Boolean).join(" ")
      );
      // The title counts double: it is what the user reads.
      const best = Math.max(title == null ? -Infinity : title * 2, other ?? -Infinity);
      return { command, order, score: best };
    })
    .filter((match) => match.score > -Infinity)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((match) => match.command);
}
