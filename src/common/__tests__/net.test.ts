import { describe, expect, it } from "vitest";
import { isPrivateIpv4, isPrivateIpv6, isIpv6, isPrivateIp } from "@common/net";

describe("isPrivateIpv4", () => {
  it("detects 10.x.x.x range", () => {
    expect(isPrivateIpv4("10.0.0.0")).toBe(true);
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("10.255.255.255")).toBe(true);
    expect(isPrivateIpv4("10.128.64.32")).toBe(true);
  });

  it("detects 172.16-31.x.x range", () => {
    expect(isPrivateIpv4("172.16.0.0")).toBe(true);
    expect(isPrivateIpv4("172.31.255.255")).toBe(true);
    expect(isPrivateIpv4("172.20.10.1")).toBe(true);
  });

  it("rejects IPs outside 172.16-31 range", () => {
    expect(isPrivateIpv4("172.15.255.255")).toBe(false);
    expect(isPrivateIpv4("172.32.0.0")).toBe(false);
  });

  it("detects 192.168.x.x range", () => {
    expect(isPrivateIpv4("192.168.0.0")).toBe(true);
    expect(isPrivateIpv4("192.168.0.1")).toBe(true);
    expect(isPrivateIpv4("192.168.255.255")).toBe(true);
  });

  it("detects 127.x.x.x loopback range", () => {
    expect(isPrivateIpv4("127.0.0.0")).toBe(true);
    expect(isPrivateIpv4("127.0.0.1")).toBe(true);
    expect(isPrivateIpv4("127.255.255.255")).toBe(true);
  });

  it("returns false for public IPs", () => {
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateIpv4("1.1.1.1")).toBe(false);
    expect(isPrivateIpv4("203.0.113.1")).toBe(false);
    expect(isPrivateIpv4("198.51.100.1")).toBe(false);
  });

  it("returns false for null/empty", () => {
    expect(isPrivateIpv4(null)).toBe(false);
    expect(isPrivateIpv4("")).toBe(false);
  });

  it("returns false for invalid input", () => {
    expect(isPrivateIpv4("not-an-ip")).toBe(false);
    expect(isPrivateIpv4("999.999.999.999")).toBe(false);
  });
});

describe("isIpv6", () => {
  it("detects IPv6 addresses", () => {
    expect(isIpv6("2001:4860:4860::8888")).toBe(true);
    expect(isIpv6("::1")).toBe(true);
    expect(isIpv6("fe80::1")).toBe(true);
  });

  it("rejects IPv4 addresses", () => {
    expect(isIpv6("8.8.8.8")).toBe(false);
    expect(isIpv6("192.168.1.1")).toBe(false);
  });
});

describe("isPrivateIpv6", () => {
  it("detects loopback ::1", () => {
    expect(isPrivateIpv6("::1")).toBe(true);
  });

  it("detects link-local fe80::/10", () => {
    expect(isPrivateIpv6("fe80::1")).toBe(true);
    expect(isPrivateIpv6("fe80::abcd:1234")).toBe(true);
  });

  it("detects unique local fc00::/7", () => {
    expect(isPrivateIpv6("fc00::1")).toBe(true);
    expect(isPrivateIpv6("fd12:3456:789a::1")).toBe(true);
  });

  it("rejects public IPv6", () => {
    expect(isPrivateIpv6("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateIpv6("2606:4700::1111")).toBe(false);
  });

  it("returns false for null/empty", () => {
    expect(isPrivateIpv6(null)).toBe(false);
    expect(isPrivateIpv6("")).toBe(false);
  });
});

describe("isPrivateIp", () => {
  it("detects private IPv4", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("detects private IPv6", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  it("rejects public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
});
