# Satellite fixtures

`gp-sample.csv` has the column layout of CelesTrak's GP data in CSV
(`https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=csv`,
header as sent on 2026-10-25). The rows are made up, except the first:
VANGUARD 1 (NORAD 5) is the SGP4 verification case of Vallado, Crawford,
Hujsak and Kelso, "Revisiting Spacetrack Report #3" (AIAA 2006-6753),
written as OMM fields. Its position at the epoch is
(7022.46529266, -1400.08296755, 0.03995155) km in TEME.

The rows after the fourth are malformed on purpose (no epoch, eccentricity
1.2, mean motion 0, `NaN`, a short row, a duplicate NORAD id, an ephemeris
type other than SGP4, no name). No downloaded CelesTrak data is stored in
the repository.
