import { describe, it, expect } from 'vitest';
import {
  aWeightDb,
  cWeightDb,
  weightingOffsets,
  applyWeightingDb
} from '../../src/lib/dsp/weighting';

describe('aWeightDb', () => {
  // Reference values from IEC 61672-1, Table 2.
  // Tolerances reflect the slight differences between the rational
  // approximation in the code vs. the exact spec table.
  const cases: Array<[number, number, number]> = [
    [10,    -70.4, 0.5],
    [20,    -50.4, 0.4],
    [50,    -30.3, 0.3],
    [100,   -19.1, 0.2],
    [200,   -10.9, 0.2],
    [500,    -3.2, 0.2],
    [1000,    0.0, 0.05],
    [2000,    1.2, 0.1],
    [4000,    1.0, 0.2],
    [8000,   -1.1, 0.3],
    [10000,  -2.5, 0.3],
    [20000, -9.3,  0.5]
  ];
  it.each(cases)('aWeightDb(%i) ≈ %f ±%f', (f, expected, tol) => {
    expect(aWeightDb(f)).toBeCloseTo(expected, -Math.log10(tol));
  });

  it('returns -Infinity at f=0', () => {
    expect(aWeightDb(0)).toBe(-Infinity);
  });
});

describe('cWeightDb', () => {
  // Reference values from IEC 61672-1, Table 2.
  const cases: Array<[number, number, number]> = [
    [10,    -14.3, 0.3],
    [20,     -6.2, 0.3],
    [50,     -1.3, 0.2],
    [100,    -0.3, 0.1],
    [1000,    0.0, 0.05],
    [4000,   -0.8, 0.2],
    [8000,   -3.0, 0.3],
    [10000,  -4.4, 0.3]
  ];
  it.each(cases)('cWeightDb(%i) ≈ %f ±%f', (f, expected, tol) => {
    expect(cWeightDb(f)).toBeCloseTo(expected, -Math.log10(tol));
  });
});

describe('weightingOffsets', () => {
  it('Z weighting returns all zeros', () => {
    const freqs = new Float32Array([10, 100, 1000, 10000]);
    const off = weightingOffsets(freqs, 'Z');
    expect(off.length).toBe(4);
    for (const v of off) expect(v).toBe(0);
  });

  it('A and C weighting at 1 kHz return ~0 dB', () => {
    const freqs = new Float32Array([1000]);
    expect(weightingOffsets(freqs, 'A')[0]).toBeCloseTo(0, 1);
    expect(weightingOffsets(freqs, 'C')[0]).toBeCloseTo(0, 1);
  });

  it('A weighting attenuates low frequencies more than C', () => {
    const freqs = new Float32Array([50]);
    const a = weightingOffsets(freqs, 'A')[0];
    const c = weightingOffsets(freqs, 'C')[0];
    expect(a).toBeLessThan(c);   // A is more negative at low freq
  });
});

describe('applyWeightingDb', () => {
  it('adds offsets element-wise into the destination buffer', () => {
    const spectrum = new Float32Array([10, 20, 30]);
    const offsets = new Float32Array([-5, 0, 5]);
    const out = new Float32Array(3);
    applyWeightingDb(spectrum, offsets, out);
    expect(Array.from(out)).toEqual([5, 20, 35]);
  });

  it('writes in-place when outDb is omitted', () => {
    const spectrum = new Float32Array([10, 20, 30]);
    const offsets = new Float32Array([-1, -2, -3]);
    applyWeightingDb(spectrum, offsets);
    expect(Array.from(spectrum)).toEqual([9, 18, 27]);
  });
});
