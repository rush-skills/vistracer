import type { TileCacheInfo } from "@common/ipc";

/** Decimal units, as file managers show them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function describeTileCache(info: TileCacheInfo): string {
  if (info.tileCount === 0) {
    return `Empty (limit ${formatBytes(info.capBytes)}).`;
  }
  const tiles = `${info.tileCount.toLocaleString("en-US")} ${info.tileCount === 1 ? "tile" : "tiles"}`;
  return `${formatBytes(info.sizeBytes)} of ${formatBytes(info.capBytes)} (${tiles}).`;
}
