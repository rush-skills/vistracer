import { eciToEcf, gstime, json2satrec, propagate, type SatRec } from "satellite.js";
import type { SatelliteElements } from "../infra/sources";

/**
 * SGP4 propagation with satellite.js (MIT). The globe adapter imports this
 * module only when the satellites layer first has data, so satellite.js is
 * not loaded at start-up.
 */

export interface GroupPropagator {
  readonly count: number;
  /**
   * Earth-fixed positions in metres at `date`, three per satellite, into
   * `out`. NaN for a satellite SGP4 cannot place (for example one that has
   * decayed since its elements were made).
   */
  positions(date: Date, out: Float64Array): void;
}

function satrec(elements: SatelliteElements): SatRec {
  return json2satrec({
    OBJECT_NAME: elements.name,
    OBJECT_ID: elements.objectId,
    EPOCH: elements.epoch,
    MEAN_MOTION: elements.meanMotion,
    ECCENTRICITY: elements.eccentricity,
    INCLINATION: elements.inclination,
    RA_OF_ASC_NODE: elements.raan,
    ARG_OF_PERICENTER: elements.argOfPericenter,
    MEAN_ANOMALY: elements.meanAnomaly,
    NORAD_CAT_ID: elements.noradId,
    ELEMENT_SET_NO: 999,
    BSTAR: elements.bstar,
    MEAN_MOTION_DOT: elements.meanMotionDot,
    MEAN_MOTION_DDOT: elements.meanMotionDdot
  });
}

export function createPropagator(satellites: readonly SatelliteElements[]): GroupPropagator {
  const records = satellites.map(satrec);
  return {
    count: records.length,
    positions(date, out) {
      // TEME to Earth-fixed by the sidereal angle only (no polar motion):
      // well under a kilometre, enough for the globe.
      const gmst = gstime(date);
      records.forEach((record, i) => {
        // Null when SGP4 fails for this time (the record's error says why).
        const eci = propagate(record, date)?.position;
        if (!eci) {
          out[3 * i] = Number.NaN;
          out[3 * i + 1] = Number.NaN;
          out[3 * i + 2] = Number.NaN;
          return;
        }
        const ecf = eciToEcf(eci, gmst);
        out[3 * i] = ecf.x * 1000;
        out[3 * i + 1] = ecf.y * 1000;
        out[3 * i + 2] = ecf.z * 1000;
      });
    }
  };
}
