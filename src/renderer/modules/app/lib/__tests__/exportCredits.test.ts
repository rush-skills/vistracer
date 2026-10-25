import { describe, expect, it } from "vitest";
import { exportCredits } from "@renderer/lib/attribution";
import { layerVisibility } from "@renderer/lib/layers";
import { drawCredits } from "../exportCapture";

const TELEGEOGRAPHY =
  "Submarine cable data © TeleGeography, www.submarinecablemap.com, licensed CC BY-NC-SA 3.0.";

describe("export credits", () => {
  it("credits TeleGeography in exports only while the cable layer is on", () => {
    expect(exportCredits(layerVisibility({}))).toEqual([]);
    expect(exportCredits(layerVisibility({ "submarine-cables": true }))).toEqual([TELEGEOGRAPHY]);
    expect(exportCredits(layerVisibility({ "submarine-cables": false, exchanges: true }))).toEqual([]);
    expect(exportCredits(layerVisibility({ satellites: true }))).toEqual([
      "Satellite positions computed from CelesTrak GP data (celestrak.org)."
    ]);
  });

  it("draws the credit lines in the lower right corner of the frame", () => {
    const texts: Array<{ text: string; x: number; y: number }> = [];
    const boxes: number[][] = [];
    const ctx = {
      font: "",
      fillStyle: "",
      textBaseline: "alphabetic" as CanvasTextBaseline,
      measureText: (text: string) => ({ width: text.length * 6 }) as TextMetrics,
      fillRect: (...box: number[]) => boxes.push(box),
      fillText: (text: string, x: number, y: number) => texts.push({ text, x, y })
    };
    drawCredits(ctx, 1920, 1080, [TELEGEOGRAPHY]);
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe(TELEGEOGRAPHY);
    const [x, y, width, height] = boxes[0];
    // Inside the frame, against its right and bottom edges.
    expect(x + width).toBeLessThanOrEqual(1920);
    expect(x + width).toBeGreaterThan(1880);
    expect(y + height).toBeLessThanOrEqual(1080);
    expect(y + height).toBeGreaterThan(1040);

    drawCredits(ctx, 1920, 1080, []);
    expect(texts).toHaveLength(1);
  });
});
