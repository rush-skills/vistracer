/**
 * E2E tests for network utility functions.
 * These are shared between frontend and backend (Rust has its own equivalent).
 */
import { describe, it, expect } from "vitest";
import { isPrivateIpv4, isPrivateIpv6, isIpv6, isPrivateIp } from "../../src/common/net";

describe("Network Utilities (TypeScript)", () => {
  describe("isPrivateIpv4", () => {
    it("detects 10.x.x.x range", () => {
      expect(isPrivateIpv4("10.0.0.1")).toBe(true);
      expect(isPrivateIpv4("10.255.255.255")).toBe(true);
    });

    it("detects 172.16-31.x.x range", () => {
      expect(isPrivateIpv4("172.16.0.1")).toBe(true);
      expect(isPrivateIpv4("172.31.255.255")).toBe(true);
      expect(isPrivateIpv4("172.15.0.1")).toBe(false);
      expect(isPrivateIpv4("172.32.0.1")).toBe(false);
    });

    it("detects 192.168.x.x range", () => {
      expect(isPrivateIpv4("192.168.0.1")).toBe(true);
      expect(isPrivateIpv4("192.168.255.255")).toBe(true);
      expect(isPrivateIpv4("192.169.0.1")).toBe(false);
    });

    it("detects 127.x.x.x loopback", () => {
      expect(isPrivateIpv4("127.0.0.1")).toBe(true);
      expect(isPrivateIpv4("127.255.255.255")).toBe(true);
    });

    it("rejects public IPs", () => {
      expect(isPrivateIpv4("8.8.8.8")).toBe(false);
      expect(isPrivateIpv4("1.1.1.1")).toBe(false);
      expect(isPrivateIpv4("203.0.113.1")).toBe(false);
    });

    it("handles null/empty input", () => {
      expect(isPrivateIpv4(null)).toBe(false);
      expect(isPrivateIpv4("")).toBe(false);
    });
  });

  describe("isIpv6", () => {
    it("detects IPv6 addresses", () => {
      expect(isIpv6("::1")).toBe(true);
      expect(isIpv6("2001:db8::1")).toBe(true);
      expect(isIpv6("fe80::1")).toBe(true);
      expect(isIpv6("2001:4860:4860::8888")).toBe(true);
    });

    it("rejects IPv4 addresses", () => {
      expect(isIpv6("8.8.8.8")).toBe(false);
      expect(isIpv6("192.168.1.1")).toBe(false);
    });
  });

  describe("isPrivateIpv6", () => {
    it("detects loopback", () => {
      expect(isPrivateIpv6("::1")).toBe(true);
    });

    it("detects link-local", () => {
      expect(isPrivateIpv6("fe80::1")).toBe(true);
      expect(isPrivateIpv6("FE80::abc")).toBe(true);
    });

    it("detects ULA", () => {
      expect(isPrivateIpv6("fc00::1")).toBe(true);
      expect(isPrivateIpv6("fd00::1")).toBe(true);
      expect(isPrivateIpv6("FD12:3456::1")).toBe(true);
    });

    it("rejects public IPv6", () => {
      expect(isPrivateIpv6("2001:db8::1")).toBe(false);
      expect(isPrivateIpv6("2001:4860:4860::8888")).toBe(false);
    });

    it("handles null input", () => {
      expect(isPrivateIpv6(null)).toBe(false);
    });
  });

  describe("isPrivateIp (unified)", () => {
    it("handles IPv4 private IPs", () => {
      expect(isPrivateIp("10.0.0.1")).toBe(true);
      expect(isPrivateIp("192.168.1.1")).toBe(true);
      expect(isPrivateIp("8.8.8.8")).toBe(false);
    });

    it("handles IPv6 private IPs", () => {
      expect(isPrivateIp("::1")).toBe(true);
      expect(isPrivateIp("fe80::1")).toBe(true);
      expect(isPrivateIp("2001:db8::1")).toBe(false);
    });

    it("handles null", () => {
      expect(isPrivateIp(null)).toBe(false);
    });
  });
});
