import type { SatelliteElements, SatelliteGroupData } from "@renderer/lib/infra/sources";
import type { SatelliteGroupId } from "@renderer/lib/satellites/groups";

/**
 * `get_satellites` records for renderer tests. VANGUARD 1 is the SGP4
 * verification case 00005 of Vallado et al., "Revisiting Spacetrack Report
 * #3" (AIAA 2006-6753), as OMM fields; the others are made up.
 */
export const VANGUARD_ROW = {
  noradId: 5,
  name: "VANGUARD 1",
  objectId: "1958-002B",
  epoch: "2000-06-27T18:50:19.733568",
  meanMotion: 10.82419157,
  eccentricity: 0.1859667,
  inclination: 34.2682,
  raan: 348.7242,
  argOfPericenter: 331.7664,
  meanAnomaly: 19.3264,
  bstar: 0.28098e-4,
  meanMotionDot: 0.23e-6,
  meanMotionDdot: 0
};

/** Vallado's TEME position of 00005, km: at the epoch and 360 minutes later. */
export const VANGUARD_TEME_KM = {
  0: [7022.46529266, -1400.08296755, 0.03995155],
  360: [-7154.03120202, -3783.17682504, -3536.19412294]
} as const;

export const starlinkRow = (noradId: number, meanAnomaly: number) => ({
  noradId,
  name: `EXAMPLE STARLINK-${noradId}`,
  objectId: "2098-001A",
  epoch: "2026-10-24T12:00:00.000000",
  meanMotion: 15.06,
  eccentricity: 0.0001,
  inclination: 53.05,
  raan: 120.5,
  argOfPericenter: 90,
  meanAnomaly,
  bstar: 0.0002,
  meanMotionDot: 0.00001,
  meanMotionDdot: 0
});

export const elements = (
  group: SatelliteGroupId,
  row: typeof VANGUARD_ROW
): SatelliteElements => ({
  ...row,
  key: `sat|${group}|${row.noradId}`,
  epochMs: Date.parse(`${row.epoch}Z`)
});

export const groupData = (
  group: SatelliteGroupId,
  rows: Array<typeof VANGUARD_ROW>,
  fetchedAt = Date.parse("2026-10-25T00:00:00Z")
): SatelliteGroupData => ({
  group,
  fetchedAt,
  note: null,
  satellites: rows.map((row) => elements(group, row)),
  rejected: 0
});
