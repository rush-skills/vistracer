import type { HopResolution } from "@common/ipc";

/**
 * Colours per network (ASN) for the "Network colours" layer.
 *
 * Palette: Paul Tol's "light" qualitative scheme, 7 of its 9 colours
 * (https://personal.sron.nl/~pault/, free to use). The colours stay apart
 * under protanopia, deuteranopia and tritanopia, and they are light, so they
 * keep 3:1 against the dark globe. lib/infra/__tests__/asnColors.test.ts
 * checks both. Hops without an ASN get a neutral grey.
 */
export const ASN_PALETTE = [
  "#77AADD",
  "#EE8866",
  "#EEDD88",
  "#FFAABB",
  "#99DDFF",
  "#44BB99",
  "#BBCC33"
] as const;

export const UNKNOWN_ASN_COLOR = "#6B7380";

export interface AsnLegendEntry {
  /** Undefined: hops without an ASN. */
  asn?: number;
  name: string | null;
  color: string;
  hopIndexes: number[];
}

export interface AsnColors {
  /** ASN → colour, for the networks on this route. */
  byAsn: ReadonlyMap<number, string>;
  /** In the order the route enters each network; "unknown" last. */
  legend: AsnLegendEntry[];
}

/**
 * Each ASN prefers the colour at `asn mod 7`, so a network usually keeps its
 * colour from one trace to the next. When two networks of one route want the
 * same colour, the one the route reaches later takes the next free colour.
 * With more than 7 networks on a route, colours repeat.
 */
export function assignAsnColors(hops: readonly HopResolution[]): AsnColors {
  const byAsn = new Map<number, string>();
  const entries = new Map<number | undefined, AsnLegendEntry>();
  const taken = new Set<number>();
  for (const hop of [...hops].sort((a, b) => a.hopIndex - b.hopIndex)) {
    if (!hop.ipAddress) {
      continue;
    }
    const asn = hop.asn?.asn ?? undefined;
    let entry = entries.get(asn);
    if (!entry) {
      let color = UNKNOWN_ASN_COLOR;
      if (asn != null) {
        const preferred = asn % ASN_PALETTE.length;
        let slot = preferred;
        for (let step = 0; step < ASN_PALETTE.length; step += 1) {
          const candidate = (preferred + step) % ASN_PALETTE.length;
          if (!taken.has(candidate)) {
            slot = candidate;
            break;
          }
        }
        taken.add(slot);
        color = ASN_PALETTE[slot];
        byAsn.set(asn, color);
      }
      entry = { asn, name: hop.asn?.name ?? null, color, hopIndexes: [] };
      entries.set(asn, entry);
    }
    entry.name ??= hop.asn?.name ?? null;
    entry.hopIndexes.push(hop.hopIndex);
  }
  const legend = [...entries.values()];
  const unknown = legend.findIndex((entry) => entry.asn == null);
  if (unknown >= 0) {
    legend.push(...legend.splice(unknown, 1));
  }
  return { byAsn, legend };
}

export function asnColor(colors: AsnColors, hop: HopResolution): string {
  const asn = hop.asn?.asn;
  return (asn != null && colors.byAsn.get(asn)) || UNKNOWN_ASN_COLOR;
}

/** "hops 3–5", "hop 4", "hops 2, 7". */
export function hopRangeText(hopIndexes: readonly number[]): string {
  if (hopIndexes.length === 1) {
    return `hop ${hopIndexes[0]}`;
  }
  const contiguous = hopIndexes.every((index, i) => i === 0 || index === hopIndexes[i - 1] + 1);
  return contiguous
    ? `hops ${hopIndexes[0]}–${hopIndexes[hopIndexes.length - 1]}`
    : `hops ${hopIndexes.join(", ")}`;
}
