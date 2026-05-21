import { describe, it, expect } from 'vitest';
import { haversine } from '../../src/lib/sensors/gps';

describe('haversine', () => {
  it('returns 0 for identical points', () => {
    expect(haversine(45.4642, 9.19, 45.4642, 9.19)).toBe(0);
  });

  it('Milan ↔ Rome ≈ 477 km', () => {
    // Milano Duomo
    const milan = [45.4642, 9.1900];
    // Roma Colosseo
    const rome  = [41.8902, 12.4924];
    const d = haversine(milan[0], milan[1], rome[0], rome[1]);
    expect(d).toBeGreaterThan(475_000);
    expect(d).toBeLessThan(480_000);
  });

  it('is symmetric', () => {
    const a = haversine(40.7128, -74.0060, 51.5074, -0.1278); // NYC ↔ London
    const b = haversine(51.5074, -0.1278, 40.7128, -74.0060);
    expect(a).toBeCloseTo(b, 3);
  });

  it('one degree at the equator ≈ 111 km', () => {
    const d = haversine(0, 0, 0, 1);
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(112_000);
  });

  it('handles antipodal points', () => {
    // Half the earth's circumference along a great circle ≈ 20 015 km
    const d = haversine(0, 0, 0, 180);
    expect(d).toBeGreaterThan(20_000_000);
    expect(d).toBeLessThan(20_100_000);
  });
});
