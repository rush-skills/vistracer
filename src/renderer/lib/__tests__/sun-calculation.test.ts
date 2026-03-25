import { describe, it, expect } from 'vitest';
import { calculateSunDirection } from '../globe';

describe('calculateSunDirection', () => {
  it('should calculate sun direction for a known date/time', () => {
    // Test with a specific date: March 20, 2024 at 12:00 UTC (spring equinox, approximately)
    const equinoxDate = new Date(Date.UTC(2024, 2, 20, 12, 0, 0));
    const sunDir = calculateSunDirection(equinoxDate);

    // At equinox at noon UTC, the sun should be roughly overhead at 0° longitude
    // and near the equator (y should be close to 0)
    expect(sunDir.y).toBeCloseTo(0, 1); // Within 0.1 due to approximations

    // The sun should be roughly on the positive X side (Greenwich meridian at noon)
    expect(sunDir.x).toBeGreaterThan(0.5);

    // Vector should be normalized
    expect(sunDir.length()).toBeCloseTo(1.0);
  });

  it('should calculate different positions for different times of day', () => {
    const date = new Date(Date.UTC(2024, 5, 15, 0, 0, 0)); // June 15, midnight UTC
    const noon = new Date(Date.UTC(2024, 5, 15, 12, 0, 0)); // June 15, noon UTC

    const sunMidnight = calculateSunDirection(date);
    const sunNoon = calculateSunDirection(noon);

    // Sun positions should be very different (roughly 180 degrees apart)
    const dotProduct = sunMidnight.dot(sunNoon);
    expect(dotProduct).toBeLessThan(0); // Opposite hemispheres
  });

  it('should calculate seasonal variations in declination', () => {
    // Summer solstice (June 21) - sun should be north of equator
    const summer = new Date(Date.UTC(2024, 5, 21, 12, 0, 0));
    const sunSummer = calculateSunDirection(summer);

    // Winter solstice (Dec 21) - sun should be south of equator
    const winter = new Date(Date.UTC(2024, 11, 21, 12, 0, 0));
    const sunWinter = calculateSunDirection(winter);

    // Y component represents north/south
    expect(sunSummer.y).toBeGreaterThan(0.2); // North of equator
    expect(sunWinter.y).toBeLessThan(-0.2); // South of equator
  });

  it('should return normalized vectors', () => {
    const now = new Date();
    const sunDir = calculateSunDirection(now);

    expect(sunDir.length()).toBeCloseTo(1.0);
  });

  it('should handle current time when no date provided', () => {
    const sunDir = calculateSunDirection();

    // Should return a valid normalized vector
    expect(sunDir.length()).toBeCloseTo(1.0);
    expect(isFinite(sunDir.x)).toBe(true);
    expect(isFinite(sunDir.y)).toBe(true);
    expect(isFinite(sunDir.z)).toBe(true);
  });
});
