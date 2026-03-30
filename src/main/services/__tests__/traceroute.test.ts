import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import type { TracerouteRequest } from "@common/ipc";

// Mock electron and electron-store before importing traceroute (which transitively imports them)
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppPath: () => "/tmp", isPackaged: false }
}));
vi.mock("electron-store", () => {
  return {
    default: class {
      #data = new Map();
      get(key: string, def?: unknown) { return this.#data.get(key) ?? def; }
      set(key: string, val: unknown) { this.#data.set(key, val); }
      delete(key: string) { this.#data.delete(key); }
    }
  };
});

import { parseHopLine, buildCommand, parseLatencyValues } from "../traceroute";

const defaultRequest: TracerouteRequest = {
  target: "8.8.8.8",
  protocol: "ICMP",
  maxHops: 30,
  timeoutMs: 4000,
  packetCount: 3,
  forceFresh: false
};

describe("parseHopLine", () => {
  it("parses a standard Unix traceroute line with parenthesized IP", () => {
    const line = " 3  router.example.com (10.0.0.1)  5.123 ms  4.567 ms  6.789 ms";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(3);
    expect(result!.ipAddress).toBe("10.0.0.1");
    expect(result!.hostName).toBe("router.example.com");
    expect(result!.rtts).toEqual([5.123, 4.567, 6.789]);
    expect(result!.lostCount).toBe(0);
  });

  it("parses a line with only an IP (no hostname)", () => {
    const line = " 5  192.168.1.1  12.345 ms  11.111 ms  10.000 ms";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(5);
    expect(result!.ipAddress).toBe("192.168.1.1");
    expect(result!.rtts).toHaveLength(3);
  });

  it("parses timeout lines (all asterisks)", () => {
    const line = " 4  * * *";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(4);
    expect(result!.ipAddress).toBeNull();
    expect(result!.rtts).toHaveLength(0);
    expect(result!.lostCount).toBe(3);
  });

  it("parses Windows tracert 'Request timed out' lines", () => {
    const line = "  7     Request timed out.";
    const result = parseHopLine(line, { ...defaultRequest, packetCount: 3 });

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(7);
    expect(result!.ipAddress).toBeNull();
    expect(result!.lostCount).toBe(3);
  });

  it("parses Windows tracert output with bracketed IP", () => {
    const line = "  3     5 ms     4 ms     6 ms  router.example.com [10.0.0.1]";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(3);
    expect(result!.ipAddress).toBe("10.0.0.1");
    expect(result!.hostName).toBe("router.example.com");
    expect(result!.rtts).toEqual([5, 4, 6]);
  });

  it("parses Windows tracert output with <1 ms latency", () => {
    const line = "  1    <1 ms    <1 ms    <1 ms  192.168.0.1";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(1);
    expect(result!.ipAddress).toBe("192.168.0.1");
    expect(result!.rtts).toEqual([1, 1, 1]);
  });

  it("handles partial timeouts (mix of RTT and asterisks)", () => {
    const line = " 6  router.net (10.0.1.1)  15.432 ms  * 18.765 ms";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(6);
    expect(result!.ipAddress).toBe("10.0.1.1");
    expect(result!.rtts).toEqual([15.432, 18.765]);
    expect(result!.lostCount).toBe(1);
  });

  it("returns null for empty lines", () => {
    expect(parseHopLine("", defaultRequest)).toBeNull();
    expect(parseHopLine("   ", defaultRequest)).toBeNull();
  });

  it("returns null for header lines", () => {
    expect(
      parseHopLine("traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 60 byte packets", defaultRequest)
    ).toBeNull();
  });

  it("handles single-digit hop indices", () => {
    const line = " 1  gateway (192.168.1.1)  1.234 ms  1.345 ms  1.456 ms";
    const result = parseHopLine(line, defaultRequest);
    expect(result!.hopIndex).toBe(1);
  });

  it("handles double-digit hop indices", () => {
    const line = "15  core-rtr.example.net (203.0.113.1)  45.678 ms  44.321 ms  46.012 ms";
    const result = parseHopLine(line, defaultRequest);
    expect(result!.hopIndex).toBe(15);
    expect(result!.ipAddress).toBe("203.0.113.1");
  });
});

describe("parseLatencyValues", () => {
  it("extracts multiple RTT values", () => {
    const values = parseLatencyValues("5.123 ms  4.567 ms  6.789 ms");
    expect(values).toEqual([5.123, 4.567, 6.789]);
  });

  it("handles <N ms format", () => {
    const values = parseLatencyValues("<1 ms  <1 ms  <1 ms");
    expect(values).toEqual([1, 1, 1]);
  });

  it("handles mixed formats", () => {
    const values = parseLatencyValues("<1 ms  5.432 ms  * 3.210 ms");
    expect(values).toEqual([1, 5.432, 3.21]);
  });

  it("returns empty array for no matches", () => {
    const values = parseLatencyValues("* * *");
    expect(values).toEqual([]);
  });
});

describe("buildCommand", () => {
  const platformSpy = vi.spyOn(os, "platform");

  beforeEach(() => {
    platformSpy.mockReset();
  });

  it("uses ICMP flag on darwin", () => {
    platformSpy.mockReturnValue("darwin");
    const result = buildCommand(defaultRequest);

    expect(result.command).toBe("/usr/sbin/traceroute");
    expect(result.args).toContain("-I");
    expect(result.args).toContain("-n");
    expect(result.args).toContain("8.8.8.8");
    expect(result.platform).toBe("darwin");
  });

  it("uses TCP flag on linux", () => {
    platformSpy.mockReturnValue("linux");
    const tcpRequest: TracerouteRequest = { ...defaultRequest, protocol: "TCP" };
    const result = buildCommand(tcpRequest);

    expect(result.command).toBe("/usr/sbin/traceroute");
    expect(result.args).toContain("-P");
    expect(result.args).toContain("tcp");
    expect(result.args).not.toContain("-I");
  });

  it("uses tracert on win32 with -d flag", () => {
    platformSpy.mockReturnValue("win32");
    const result = buildCommand(defaultRequest);

    expect(result.command).toBe("tracert");
    expect(result.args).toContain("-d");
    expect(result.platform).toBe("win32");
  });

  it("uses traceroute6 for IPv6 on darwin", () => {
    platformSpy.mockReturnValue("darwin");
    const ipv6Request: TracerouteRequest = { ...defaultRequest, target: "2001:4860:4860::8888" };
    const result = buildCommand(ipv6Request);

    expect(result.command).toBe("/usr/sbin/traceroute6");
    expect(result.args).not.toContain("-I");
  });

  it("uses tracert with -6 flag for IPv6 on win32", () => {
    platformSpy.mockReturnValue("win32");
    const ipv6Request: TracerouteRequest = { ...defaultRequest, target: "2001:4860:4860::8888" };
    const result = buildCommand(ipv6Request);

    expect(result.command).toBe("tracert");
    expect(result.args).toContain("-6");
  });

  it("does not add protocol flags for UDP on Unix", () => {
    platformSpy.mockReturnValue("linux");
    const udpRequest: TracerouteRequest = { ...defaultRequest, protocol: "UDP" };
    const result = buildCommand(udpRequest);

    expect(result.args).not.toContain("-I");
    expect(result.args).not.toContain("-P");
  });
});

describe("parseHopLine (IPv6)", () => {
  it("parses traceroute6 output with bare IPv6 address", () => {
    const line = " 1  2001:4860:0:1::1  5.432 ms  4.321 ms  6.543 ms";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(1);
    expect(result!.ipAddress).toBe("2001:4860:0:1::1");
    expect(result!.rtts).toHaveLength(3);
  });

  it("parses IPv6 in parentheses", () => {
    const line = " 3  router.v6.example.com (2001:db8::1)  10.123 ms  9.456 ms  11.789 ms";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(3);
    expect(result!.ipAddress).toBe("2001:db8::1");
    expect(result!.hostName).toBe("router.v6.example.com");
  });

  it("parses IPv6 in brackets (Windows)", () => {
    const line = "  2     5 ms     4 ms     6 ms  router.example.com [2001:db8::abcd]";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.hopIndex).toBe(2);
    expect(result!.ipAddress).toBe("2001:db8::abcd");
  });

  it("parses compressed IPv6 (::1)", () => {
    const line = " 1  ::1  0.123 ms  0.100 ms  0.110 ms";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.ipAddress).toBe("::1");
  });

  it("handles IPv6 timeout lines", () => {
    const line = " 5  * * *";
    const result = parseHopLine(line, defaultRequest);

    expect(result).not.toBeNull();
    expect(result!.ipAddress).toBeNull();
  });
});
