import { describe, expect, it } from "vitest";
import { describeTileCache, formatBytes } from "../tileCache";

describe("tile cache text", () => {
  it("formats sizes in decimal units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(12_345)).toBe("12 KB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(524_288_000)).toBe("524 MB");
    expect(formatBytes(3_200_000_000)).toBe("3.2 GB");
  });

  it("describes the cache with its limit", () => {
    expect(describeTileCache({ sizeBytes: 0, tileCount: 0, capBytes: 500_000_000 })).toBe(
      "Empty (limit 500 MB)."
    );
    expect(describeTileCache({ sizeBytes: 1_250_000, tileCount: 1, capBytes: 500_000_000 })).toBe(
      "1.3 MB of 500 MB (1 tile)."
    );
    expect(
      describeTileCache({ sizeBytes: 48_700_000, tileCount: 2_311, capBytes: 500_000_000 })
    ).toBe("49 MB of 500 MB (2,311 tiles).");
  });
});
