// Standard window functions for FFT analysis.
// All return a Float32Array of length N with values in [0, 1].

export type WindowName =
  | 'rectangular'
  | 'hann'
  | 'hamming'
  | 'blackman'
  | 'blackman-harris'
  | 'flat-top';

export const WINDOW_NAMES: WindowName[] = [
  'rectangular',
  'hann',
  'hamming',
  'blackman',
  'blackman-harris',
  'flat-top'
];

/** Coherent gain — divide the spectrum by this to get amplitude-correct values. */
export function coherentGain(w: Float32Array): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  return s / w.length;
}

/** Equivalent noise bandwidth in bins — for power-spectral-density scaling. */
export function enbw(w: Float32Array): number {
  let s1 = 0, s2 = 0;
  for (let i = 0; i < w.length; i++) { s1 += w[i]; s2 += w[i] * w[i]; }
  return (w.length * s2) / (s1 * s1);
}

export function makeWindow(name: WindowName, N: number): Float32Array {
  const w = new Float32Array(N);
  switch (name) {
    case 'rectangular':
      w.fill(1);
      break;
    case 'hann':
      for (let n = 0; n < N; n++) {
        w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
      }
      break;
    case 'hamming':
      for (let n = 0; n < N; n++) {
        w[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
      }
      break;
    case 'blackman':
      for (let n = 0; n < N; n++) {
        const x = (2 * Math.PI * n) / (N - 1);
        w[n] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
      }
      break;
    case 'blackman-harris':
      for (let n = 0; n < N; n++) {
        const x = (2 * Math.PI * n) / (N - 1);
        w[n] = 0.35875
          - 0.48829 * Math.cos(x)
          + 0.14128 * Math.cos(2 * x)
          - 0.01168 * Math.cos(3 * x);
      }
      break;
    case 'flat-top': {
      // Coefficients from MATLAB flattopwin
      const a0 = 0.21557895, a1 = 0.41663158, a2 = 0.277263158,
            a3 = 0.083578947, a4 = 0.006947368;
      for (let n = 0; n < N; n++) {
        const x = (2 * Math.PI * n) / (N - 1);
        w[n] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x)
             - a3 * Math.cos(3 * x) + a4 * Math.cos(4 * x);
      }
      break;
    }
  }
  return w;
}
