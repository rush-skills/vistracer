import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * WCAG AA for the text tokens of both themes. A glass panel is see-through,
 * so the colour behind its text is the glass blended over the globe; the
 * check uses the worst case: dark glass over white imagery, light glass over
 * black space. Solid panels (reduced transparency) are checked too.
 */

const css = fs.readFileSync(path.resolve(__dirname, "../tokens.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`tokens.css has no ${selector} block`);
  }
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()])
  );
}

const dark = block(":root");
const light = { ...dark, ...block(':root[data-theme="light"]') };

type Rgba = [number, number, number, number];

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(",").map(Number);
    return [r, g, b, a];
  }
  throw new Error(`not a colour: ${value}`);
}

const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [
  r * a + br * (1 - a),
  g * a + bg * (1 - a),
  b * a + bb * (1 - a),
  1
];

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_TOKENS = [
  "--color-text",
  "--color-text-muted",
  "--color-accent-text",
  "--color-amber",
  "--color-danger",
  "--color-violet"
];

const WHITE: Rgba = [255, 255, 255, 1];
const BLACK: Rgba = [0, 0, 0, 1];

describe.each([
  ["dark", dark, WHITE],
  ["light", light, BLACK]
] as const)("%s theme", (_name, tokens, worstBackdrop) => {
  const glass = over(parse(tokens["--glass-bg"]), worstBackdrop);
  const solid = parse(tokens["--glass-bg-solid"]);

  it.each(TEXT_TOKENS)("%s keeps 4.5:1 on glass and on solid panels", (token) => {
    const text = parse(tokens[token]);
    expect(contrast(text, glass)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, solid)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps 4.5:1 for text on accent buttons", () => {
    expect(
      contrast(parse(tokens["--color-on-accent"]), parse(tokens["--color-accent"]))
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("motion and transparency preferences", () => {
  it("drops every duration with prefers-reduced-motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const token of ["--motion-quick", "--motion-base", "--motion-panel"]) {
      expect(reduced).toMatch(new RegExp(`${token}: 0ms`));
    }
  });

  it("makes panels solid with prefers-reduced-transparency", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-transparency: reduce)"));
    expect(reduced).toMatch(/--glass-bg: var\(--glass-bg-solid\)/);
    expect(reduced).toMatch(/--glass-blur: 0px/);
  });
});
