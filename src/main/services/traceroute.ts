import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import os from "node:os";
import { lookupGeo } from "./geo";
import { resolveReverseDns } from "./dns";
import {
  HopResolution,
  HopLatencyStats,
  TracerouteProgressEvent,
  TracerouteRequest,
  TracerouteRun,
  TracerouteSummary
} from "@common/ipc";
import { isPrivateIp, isIpv6 } from "@common/net";
import { getLogger } from "./logger";

const log = getLogger();

interface TracerouteContext {
  runId: string;
  request: TracerouteRequest;
  startedAt: number;
  hopMap: Map<number, HopResolution>;
  child: ChildProcessWithoutNullStreams;
  onUpdate: (event: TracerouteProgressEvent) => void;
  canceled: boolean;
  completed: boolean;
}

const activeRuns = new Map<string, TracerouteContext>();

export class TracerouteError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "TracerouteError";
  }
}

const IP_REGEX = /(\d{1,3}(?:\.\d{1,3}){3})/g;
const IPV6_REGEX = /([0-9a-fA-F:]{2,39}(?:::[0-9a-fA-F]{0,4})*)/g;

function normalizeRequest(request: TracerouteRequest): TracerouteRequest {
  return {
    target: request.target,
    protocol: request.protocol ?? "ICMP",
    maxHops: Math.min(Math.max(request.maxHops ?? 30, 1), 64),
    timeoutMs: Math.max(request.timeoutMs ?? 4000, 1000),
    packetCount: Math.min(Math.max(request.packetCount ?? 3, 1), 5),
    forceFresh: request.forceFresh ?? false
  };
}

function isIpv6Target(target: string): boolean {
  // Check if the target itself is an IPv6 address
  return isIpv6(target);
}

function buildCommand(
  request: TracerouteRequest
): { command: string; args: string[]; platform: NodeJS.Platform } {
  const platform = os.platform();
  const ipv6 = isIpv6Target(request.target);

  if (platform === "win32") {
    const args: string[] = [
      "-d",
      "-h",
      String(request.maxHops),
      "-w",
      String(Math.max(Math.round(request.timeoutMs), 1000))
    ];
    if (ipv6) {
      args.push("-6");
    }
    args.push(request.target);
    return { command: "tracert", args, platform };
  }

  const args: string[] = [
    "-n",
    "-m",
    String(request.maxHops),
    "-q",
    String(request.packetCount),
    "-w",
    String(Math.ceil(request.timeoutMs / 1000))
  ];

  if (!ipv6 && request.protocol === "ICMP") {
    args.unshift("-I");
  } else if (!ipv6 && request.protocol === "TCP") {
    args.push("-P", "tcp");
  }

  args.push(request.target);

  let command: string;
  if (ipv6) {
    // Use traceroute6 for IPv6 on Unix
    command = platform === "darwin" || platform === "linux"
      ? "/usr/sbin/traceroute6"
      : "traceroute6";
  } else {
    command = platform === "darwin" || platform === "linux"
      ? "/usr/sbin/traceroute"
      : "traceroute";
  }

  return { command, args, platform };
}

interface ParsedHop {
  hopIndex: number;
  ipAddress: string | null;
  hostName?: string;
  rtts: number[];
  lostCount: number;
  rawLine: string;
}

function parseLatencyValues(remainder: string): number[] {
  const matches = Array.from(remainder.matchAll(/(<\d+|\d+(?:\.\d+)?)\s*ms/gi));
  return matches.map((match) => {
    const raw = match[1];
    if (raw.startsWith("<")) {
      return Number.parseFloat(raw.slice(1)) || 1;
    }
    return Number.parseFloat(raw);
  });
}

function parseHopLine(line: string, request: TracerouteRequest): ParsedHop | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const hopMatch = trimmed.match(/^(\d+)\s+(.*)$/);
  if (!hopMatch) {
    return null;
  }

  const hopIndex = Number.parseInt(hopMatch[1], 10);
  const remainder = hopMatch[2];

  if (remainder.includes("Request timed out") || remainder.split(" ").every((token) => token === "*")) {
    return {
      hopIndex,
      ipAddress: null,
      hostName: undefined,
      rtts: [],
      lostCount: request.packetCount,
      rawLine: line
    };
  }

  let ipAddress: string | null = null;
  let hostName: string | undefined;

  // Match IPv4 in parentheses: hostname (1.2.3.4)
  const parenMatch = remainder.match(/([^\s]+)?\s*\((\d{1,3}(?:\.\d{1,3}){3})\)/);
  if (parenMatch) {
    hostName = parenMatch[1];
    ipAddress = parenMatch[2];
  }

  // Match IPv6 in parentheses: hostname (2001:db8::1)
  if (!ipAddress) {
    const parenV6Match = remainder.match(/([^\s]+)?\s*\(([0-9a-fA-F:]{2,39}(?:::[0-9a-fA-F]{0,4})*)\)/);
    if (parenV6Match && parenV6Match[2].includes(":")) {
      hostName = parenV6Match[1];
      ipAddress = parenV6Match[2];
    }
  }

  // Match IPv4 in brackets: hostname [1.2.3.4] (Windows tracert)
  const bracketMatch = remainder.match(/([^\s]+)?\s*\[(\d{1,3}(?:\.\d{1,3}){3})\]/);
  if (!ipAddress && bracketMatch) {
    hostName = bracketMatch[1];
    ipAddress = bracketMatch[2];
  }

  // Match IPv6 in brackets: hostname [2001:db8::1] (Windows tracert)
  if (!ipAddress) {
    const bracketV6Match = remainder.match(/([^\s]+)?\s*\[([0-9a-fA-F:]{2,39}(?:::[0-9a-fA-F]{0,4})*)\]/);
    if (bracketV6Match && bracketV6Match[2].includes(":")) {
      hostName = bracketV6Match[1];
      ipAddress = bracketV6Match[2];
    }
  }

  // Fallback: bare IPv4
  if (!ipAddress) {
    const ips = Array.from(remainder.matchAll(IP_REGEX));
    if (ips.length > 0) {
      ipAddress = ips[ips.length - 1][1];
    }
  }

  // Fallback: bare IPv6 (e.g. traceroute6 output with -n)
  if (!ipAddress) {
    const v6Matches = Array.from(remainder.matchAll(IPV6_REGEX));
    for (const m of v6Matches) {
      // Must contain at least two colons to be a plausible IPv6 address
      if ((m[1].match(/:/g) || []).length >= 2) {
        ipAddress = m[1];
        break;
      }
    }
  }

  const rtts = parseLatencyValues(remainder);
  const lostCount = Math.max(request.packetCount - rtts.length, 0);

  return {
    hopIndex,
    ipAddress,
    hostName,
    rtts,
    lostCount,
    rawLine: line
  };
}

function computeLatencyStats(values: number[]): HopLatencyStats {
  if (values.length === 0) {
    return {
      minRttMs: null,
      maxRttMs: null,
      avgRttMs: null,
      jitterMs: null
    };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((acc, value) => acc + value, 0) / values.length;
  const jitter = values.length > 1 ? max - min : 0;

  return {
    minRttMs: Number(min.toFixed(2)),
    maxRttMs: Number(max.toFixed(2)),
    avgRttMs: Number(avg.toFixed(2)),
    jitterMs: values.length > 1 ? Number(jitter.toFixed(2)) : null
  };
}

async function toHopResolution(
  parsed: ParsedHop,
  request: TracerouteRequest,
  onEnrichmentUpdate?: (hop: HopResolution) => void
): Promise<HopResolution> {
  const latency = computeLatencyStats(parsed.rtts);
  const lossPercent = request.packetCount
    ? Number(((parsed.lostCount / request.packetCount) * 100).toFixed(2))
    : null;

  const hostName =
    parsed.hostName ||
    (parsed.ipAddress ? await resolveReverseDns(parsed.ipAddress, { forceRefresh: request.forceFresh }) : undefined);

  const geoLookup = parsed.ipAddress
    ? await lookupGeo(parsed.ipAddress, {
        forceRefresh: request.forceFresh,
        // When enrichment completes, send updated hop data
        onEnrichmentComplete: (enrichedData) => {
          if (onEnrichmentUpdate) {
            const enrichedHop: HopResolution = {
              hopIndex: parsed.hopIndex,
              ipAddress: parsed.ipAddress,
              hostName,
              lossPercent,
              latency,
              geo: enrichedData.geo,
              asn: enrichedData.asn,
              providers: enrichedData.providers,
              peeringDb: enrichedData.peeringDb,
              isPrivate: isPrivateIp(parsed.ipAddress),
              isAnycastSuspected: false,
              rawLine: parsed.rawLine
            };
            log.info(`[traceroute] Sending enriched hop update for ${parsed.ipAddress}`);
            onEnrichmentUpdate(enrichedHop);
          }
        }
      })
    : undefined;

  return {
    hopIndex: parsed.hopIndex,
    ipAddress: parsed.ipAddress,
    hostName,
    lossPercent,
    latency,
    geo: geoLookup?.geo,
    asn: geoLookup?.asn,
    providers: geoLookup?.providers ?? [],
    peeringDb: geoLookup?.peeringDb,
    isPrivate: isPrivateIp(parsed.ipAddress),
    isAnycastSuspected: false,
    rawLine: parsed.rawLine
  };
}

async function processLine(
  context: TracerouteContext,
  line: string
): Promise<HopResolution | null> {
  const parsed = parseHopLine(line, context.request);
  if (!parsed) {
    return null;
  }

  // Pass enrichment callback to send progressive updates
  const hop = await toHopResolution(parsed, context.request, (enrichedHop) => {
    // Update the hop map with enriched data
    context.hopMap.set(enrichedHop.hopIndex, enrichedHop);

    // Send progressive update to UI
    // If traceroute already completed, send hop-only update without changing completion status
    if (context.completed) {
      log.info(`[traceroute] Sending enrichment update for completed run ${context.runId}`);
      context.onUpdate({
        runId: context.runId,
        hop: enrichedHop,
        completed: true // Keep completed status
      });
    } else {
      context.onUpdate({ runId: context.runId, hop: enrichedHop, completed: false });
    }
  });

  context.hopMap.set(hop.hopIndex, hop);
  context.onUpdate({ runId: context.runId, hop, completed: false });
  return hop;
}

function createSummary(context: TracerouteContext, error?: Error): TracerouteSummary {
  const hops = Array.from(context.hopMap.values());
  return {
    target: context.request.target,
    startedAt: context.startedAt,
    completedAt: Date.now(),
    hopCount: hops.length,
    protocolsTried: [context.request.protocol],
    error: error?.message
  };
}

export async function runTraceroute(
  request: TracerouteRequest,
  onUpdate: (event: TracerouteProgressEvent) => void
): Promise<{ run: TracerouteRun; runId: string }> {
  const normalizedRequest = normalizeRequest(request);
  const { command, args } = buildCommand(normalizedRequest);
  const startedAt = Date.now();
  const runId = randomUUID();

  log.info(`Starting traceroute run ${runId} via ${command}`, args);

  const child = spawn(command, args, {
    windowsHide: true,
    shell: false,
    env: process.env
  });

  let stderrOutput = "";
  child.stderr.on("data", (data) => {
    const message = data.toString();
    stderrOutput += message;
    log.warn(`Traceroute stderr [${runId}]: ${message}`);
  });

  onUpdate({
    runId,
    completed: false,
    summary: {
      target: normalizedRequest.target,
      startedAt,
      hopCount: 0,
      completedAt: undefined,
      protocolsTried: [normalizedRequest.protocol]
    }
  });

  const context: TracerouteContext = {
    runId,
    request: normalizedRequest,
    startedAt,
    hopMap: new Map(),
    child,
    onUpdate,
    canceled: false,
    completed: false
  };

  activeRuns.set(runId, context);

  const rl = readline.createInterface({ input: child.stdout });
  let processing: Promise<void> = Promise.resolve();

  rl.on("line", (line) => {
    processing = processing
      .then(async () => {
        try {
          await processLine(context, line);
        } catch (error) {
          log.error("Failed to process traceroute line", error);
        }
      });
  });

  const exitCode: number = await new Promise<number>((resolve, reject) => {
    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code: number | null) => {
      resolve(typeof code === "number" ? code : 0);
    });
  }).finally(() => {
    rl.close();
  });

  await processing;

  activeRuns.delete(runId);

  if (exitCode !== 0) {
    log.warn(`Traceroute process exited with code ${exitCode} for run ${runId}`);
    if (stderrOutput) {
      log.warn(`Traceroute stderr output: ${stderrOutput}`);
    }
  }

  const hopList = Array.from(context.hopMap.values()).sort((a, b) => a.hopIndex - b.hopIndex);
  let exitError =
    exitCode === 0
      ? undefined
      : new TracerouteError(
          stderrOutput
            ? `Traceroute failed: ${stderrOutput.trim()}`
            : `Traceroute exited with code ${exitCode}`
        );

  if (context.canceled) {
    exitError = new TracerouteError("Traceroute run cancelled", "cancelled");
  }

  const summary = createSummary(context, exitError);

  const run: TracerouteRun = {
    request: normalizedRequest,
    summary,
    hops: hopList
  };

  // Mark context as completed so enrichment callbacks know not to change status
  context.completed = true;

  onUpdate({
    runId,
    completed: true,
    summary,
    hops: hopList,
    error: exitError?.message
  });

  // Don't throw error if the run was cancelled - it's expected behavior
  // Only throw for actual failures
  if (exitError && !context.canceled) {
    throw exitError;
  }

  return { run, runId };
}

export function cancelTraceroute(runId: string): void {
  const context = activeRuns.get(runId);
  if (!context) {
    return;
  }

  context.canceled = true;

  try {
    context.child.kill("SIGINT");
    log.info(`Cancelled traceroute run ${runId}`);
  } catch (error) {
    log.error(`Failed to cancel traceroute run ${runId}`, error);
  } finally {
    activeRuns.delete(runId);
  }
}
