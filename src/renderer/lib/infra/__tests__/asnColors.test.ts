import { describe, expect, it } from "vitest";
import type { HopResolution } from "@common/ipc";
import {
  ASN_PALETTE,
  UNKNOWN_ASN_COLOR,
  asnColor,
  assignAsnColors,
  hopRangeText
} from "@renderer/lib/infra/asnColors";
import { makeHop } from "@renderer/test/fixtures";

const hop = (hopIndex: number, asn?: number, name = `NET-${asn}`): HopResolution =>
  makeHop(hopIndex, `198.51.100.${hopIndex}`, 10 * hopIndex, {
    asn: asn == null ? null : { asn, name }
  });

describe("assignAsnColors", () => {
  it("gives a network the same colour on another route, from its ASN", () => {
    const first = assignAsnColors([hop(1, 3356), hop(2, 1299)]);
    const second = assignAsnColors([hop(1, 6453), hop(2, 3356)]);
    expect(first.byAsn.get(3356)).toBe(ASN_PALETTE[3356 % ASN_PALETTE.length]);
    expect(second.byAsn.get(3356)).toBe(first.byAsn.get(3356));
  });

  it("keeps the networks of one route apart, in the order the route reaches them", () => {
    // 7 and 14 both prefer slot 0; the later one takes the next free colour.
    const colors = assignAsnColors([hop(1, 7), hop(2, 14), hop(3, 21)]);
    expect([7, 14, 21].map((asn) => colors.byAsn.get(asn))).toEqual([
      ASN_PALETTE[0],
      ASN_PALETTE[1],
      ASN_PALETTE[2]
    ]);
    const many = assignAsnColors(Array.from({ length: 7 }, (_, i) => hop(i + 1, 100 + i * 7)));
    expect(new Set(many.byAsn.values()).size).toBe(7);
  });

  it("repeats colours only past the palette size", () => {
    const colors = assignAsnColors(Array.from({ length: 9 }, (_, i) => hop(i + 1, 1000 + i)));
    expect(colors.byAsn.size).toBe(9);
    expect(new Set(colors.byAsn.values()).size).toBe(ASN_PALETTE.length);
  });

  it("gives hops without an ASN the neutral colour and lists them last", () => {
    const hops = [hop(1), hop(2, 9498, "BHARTI"), hop(3, 9498), makeHop(4, null, null), hop(5, 6453)];
    const colors = assignAsnColors(hops);
    expect(asnColor(colors, hops[0])).toBe(UNKNOWN_ASN_COLOR);
    expect(asnColor(colors, hops[1])).toBe(colors.byAsn.get(9498));
    expect(colors.legend.map((entry) => [entry.asn, entry.hopIndexes])).toEqual([
      [9498, [2, 3]],
      [6453, [5]],
      [undefined, [1]]
    ]);
    expect(colors.legend[0].name).toBe("BHARTI");
    expect(ASN_PALETTE).not.toContain(UNKNOWN_ASN_COLOR);
  });
});

describe("hopRangeText", () => {
  it("names one hop, a run of hops, or a list", () => {
    expect(hopRangeText([4])).toBe("hop 4");
    expect(hopRangeText([2, 3, 4])).toBe("hops 2–4");
    expect(hopRangeText([2, 7])).toBe("hops 2, 7");
  });
});

// Colour science for the palette checks: WCAG relative luminance, and the
// Machado et al. (2009) simulation of full protanopia, deuteranopia and
// tritanopia in linear RGB, compared in CIELAB (ΔE*76).
type Rgb = [number, number, number];
const hex = (value: string): Rgb =>
  [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as Rgb;
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const CVD: Record<string, number[][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998]
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881]
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039]
  ]
};
const lab = (rgb: Rgb, matrix: number[][]) => {
  const l = rgb.map(linear);
  const [r, g, b] = matrix.map((row) =>
    Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2]))
  );
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};

describe("network colour palette", () => {
  // The globe's backdrops: space (--globe-space), dark ocean, the night side.
  const BACKDROPS = ["#0D0E14", "#0A2246", "#000000"];

  it("keeps 3:1 against the dark globe (non-text contrast, WCAG 1.4.11)", () => {
    for (const color of [...ASN_PALETTE, UNKNOWN_ASN_COLOR]) {
      for (const backdrop of BACKDROPS) {
        expect(contrast(hex(color), hex(backdrop)), `${color} on ${backdrop}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it.each(Object.keys(CVD))("keeps every pair apart under %s (ΔE ≥ 12)", (kind) => {
    const colors = [...ASN_PALETTE, UNKNOWN_ASN_COLOR];
    for (let i = 0; i < colors.length; i += 1) {
      for (let j = i + 1; j < colors.length; j += 1) {
        const [a, b] = [lab(hex(colors[i]), CVD[kind]), lab(hex(colors[j]), CVD[kind])];
        const delta = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        expect(delta, `${colors[i]} / ${colors[j]}`).toBeGreaterThanOrEqual(12);
      }
    }
  });
});
