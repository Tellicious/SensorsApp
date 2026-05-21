// IEC 61672-1 A and C weighting curves applied in the frequency domain.
// Simpler & cheaper than biquad cascades, accurate enough for live display.

export type Weighting = 'Z' | 'A' | 'C';

const C1 = 12194.217 ** 2;
const C2 = 20.598997 ** 2;
const C3 = 107.65265 ** 2;
const C4 = 737.86223 ** 2;

/** A-weighting response in dB, at a given frequency in Hz. */
export function aWeightDb(f: number): number {
  if (f <= 0) return -Infinity;
  const f2 = f * f;
  const num = C1 * f2 * f2;
  const den =
    (f2 + C2) *
    Math.sqrt((f2 + C3) * (f2 + C4)) *
    (f2 + C1);
  const ra = num / den;
  return 20 * Math.log10(ra) + 2.0;
}

/** C-weighting response in dB, at a given frequency in Hz. */
export function cWeightDb(f: number): number {
  if (f <= 0) return -Infinity;
  const f2 = f * f;
  const num = C1 * f2;
  const den = (f2 + C2) * (f2 + C1);
  const rc = num / den;
  return 20 * Math.log10(rc) + 0.062;
}

/** Pre-compute a weighting offset array (dB per bin) for a given freq vector. */
export function weightingOffsets(freqs: Float32Array, w: Weighting): Float32Array {
  const out = new Float32Array(freqs.length);
  if (w === 'Z') return out; // all zeros
  const fn = w === 'A' ? aWeightDb : cWeightDb;
  for (let i = 0; i < freqs.length; i++) {
    const v = fn(freqs[i]);
    out[i] = isFinite(v) ? v : -200;
  }
  return out;
}

/**
 * Apply weighting to a dB spectrum (in-place if outDb omitted).
 */
export function applyWeightingDb(
  spectrumDb: Float32Array,
  offsets: Float32Array,
  outDb?: Float32Array
): Float32Array {
  const dst = outDb ?? spectrumDb;
  for (let i = 0; i < spectrumDb.length; i++) dst[i] = spectrumDb[i] + offsets[i];
  return dst;
}

/**
 * Compute weighted broadband level (Leq-style) from a magnitude spectrum.
 * mag: amplitude (linear) per bin, weighting offsets in dB. Returns dB SPL-ish
 * (or dBFS if no SPL calibration is applied externally).
 */
export function weightedBroadbandDb(
  mag: Float32Array,
  weightOffsets: Float32Array
): number {
  let p = 0;
  for (let i = 0; i < mag.length; i++) {
    // convert dB offset back to linear, multiply with squared magnitude
    const gain = Math.pow(10, weightOffsets[i] / 10);
    p += mag[i] * mag[i] * gain;
  }
  return p > 0 ? 10 * Math.log10(p) : -200;
}
