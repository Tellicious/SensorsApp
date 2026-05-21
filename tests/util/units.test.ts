import { describe, it, expect } from 'vitest';
import { fmtDistance, fmtSpeed, fmtAltitude, unitLabel, convert } from '../../src/lib/util/units';

describe('fmtDistance', () => {
  it('SI: meters under 1 km', () => {
    expect(fmtDistance(0, 'si')).toBe('0.00 m');
    expect(fmtDistance(12.34, 'si')).toBe('12.3 m');
    expect(fmtDistance(125.6, 'si')).toBe('126 m');
    expect(fmtDistance(999, 'si')).toBe('999 m');
  });
  it('SI: kilometers at or above 1 km', () => {
    expect(fmtDistance(1000, 'si')).toBe('1.00 km');
    expect(fmtDistance(12345, 'si')).toBe('12.35 km');
  });
  it('imperial: feet under 1 mile', () => {
    expect(fmtDistance(100, 'imperial')).toBe('328 ft');
  });
  it('imperial: miles above 1 mile', () => {
    expect(fmtDistance(5000, 'imperial')).toBe('3.11 mi');
  });
  it('null/NaN ⇒ "—"', () => {
    expect(fmtDistance(null, 'si')).toBe('—');
    expect(fmtDistance(undefined, 'si')).toBe('—');
    expect(fmtDistance(NaN, 'si')).toBe('—');
  });
});

describe('fmtSpeed', () => {
  it('SI: m/s only when companion=false', () => {
    expect(fmtSpeed(10, 'si')).toBe('10.00 m/s');
  });
  it('SI: with km/h companion when companion=true', () => {
    expect(fmtSpeed(10, 'si', true)).toBe('10.00 m/s · 36.0 km/h');
  });
  it('imperial: mph', () => {
    expect(fmtSpeed(10, 'imperial')).toBe('22.4 mph');
  });
  it('null ⇒ "—"', () => {
    expect(fmtSpeed(null, 'si')).toBe('—');
  });
});

describe('fmtAltitude', () => {
  it('SI: meters with 1 decimal', () => {
    expect(fmtAltitude(123.4, 'si')).toBe('123.4 m');
  });
  it('imperial: feet with 1 decimal', () => {
    expect(fmtAltitude(100, 'imperial')).toBe('328.1 ft');
  });
});

describe('unitLabel', () => {
  it('returns the unit suffix only', () => {
    expect(unitLabel('speed', 'si')).toBe('m/s');
    expect(unitLabel('speed', 'imperial')).toBe('mph');
    expect(unitLabel('altitude', 'si')).toBe('m');
    expect(unitLabel('altitude', 'imperial')).toBe('ft');
    expect(unitLabel('distance', 'si')).toBe('km');
    expect(unitLabel('distance', 'imperial')).toBe('mi');
  });
});

describe('convert', () => {
  it('SI is identity', () => {
    expect(convert(42, 'speed', 'si')).toBe(42);
    expect(convert(42, 'altitude', 'si')).toBe(42);
    expect(convert(42, 'distance', 'si')).toBe(42);
  });
  it('imperial speed: m/s → mph', () => {
    // 10 m/s = 22.369 mph
    expect(convert(10, 'speed', 'imperial')).toBeCloseTo(22.369, 2);
  });
  it('imperial altitude/distance: m → ft', () => {
    // 100 m = 328.08 ft
    expect(convert(100, 'altitude', 'imperial')).toBeCloseTo(328.08, 1);
    expect(convert(100, 'distance', 'imperial')).toBeCloseTo(328.08, 1);
  });
});
