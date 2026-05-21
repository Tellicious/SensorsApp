/**
 * Settings store.
 *
 * Single source of truth for every user-tunable parameter in the app.
 * Persisted to `localStorage` under one JSON key so the whole tree is
 * loaded/saved atomically. Reactive: every subscriber receives updates
 * the moment any nested field changes.
 *
 * On any write, this module also reflects the theme choice onto
 * `document.documentElement.dataset.theme` so the CSS variables in
 * app.css can pick the right palette without further bookkeeping.
 *
 * Helpers:
 *   - resetSettings()         → restore DEFAULTS
 *   - exportSettingsJson()    → pretty JSON for clipboard / file download
 *   - importSettingsJson(str) → parse + merge over DEFAULTS
 *   - updateMotion/Audio/Gps/Global({...patch}) → shallow patch a slice
 */
import { writable, get } from 'svelte/store';
import type { WindowName } from '$lib/dsp/windowing';
import type { FftSize } from '$lib/dsp/fft';
import type { Weighting } from '$lib/dsp/weighting';

export type Theme = 'dark' | 'light' | 'auto';
export type CoordFormat = 'decimal' | 'dms';
export type Unit = 'si' | 'imperial';

export interface MotionSettings {
  // which channels to display
  showLinear: boolean;
  showRaw: boolean;
  showGyro: boolean;
  showOrientation: boolean;
  showMagnitude: boolean;
  // axes
  axisX: boolean;
  axisY: boolean;
  axisZ: boolean;
  // time-domain window seconds
  timeWindowSec: number;
  // FFT
  fftSize: FftSize;
  fftWindow: WindowName;
  fftOverlapPct: 0 | 25 | 50 | 75;
  fftScaleLog: boolean;       // y-axis log (dB)
  fftFreqLog: boolean;        // x-axis log
  fftAutoScale: boolean;
  fftYMin: number;
  fftYMax: number;
  // KPI
  rmsWindowSec: number;
  meanWindowSec: number;
  peakHoldDecayDbPerSec: number;
  dominantFreqCount: number;
  // 3D cube
  showCube: boolean;
}

export interface AudioSettings {
  // visualizations
  showWaveform: boolean;
  showSpectrum: boolean;
  showSpectrogram: boolean;
  waveformWindowMs: 50 | 100 | 500 | 1000;
  // FFT
  fftSize: FftSize;
  fftWindow: WindowName;
  fftOverlapPct: 0 | 25 | 50 | 75;
  fftScaleLog: boolean;
  fftFreqLog: boolean;
  // weighting
  weighting: Weighting;
  // calibration (dB offset added to weighted dBFS to get dB SPL)
  calibration: {
    offsetDb: number;
    method: 'external' | 'sensitivity' | 'none';
    referenceLevel: number | null;
    sigma: number | null;
    calibratedAt: number | null;
    audioConstraintsHash: string | null;
  };
  // KPI
  rmsWindowSec: number;
  dominantFreqCount: number;
}

export interface GpsSettings {
  coordFormat: CoordFormat;
  movementThresholdMps: number;
  showMap: boolean;
  showTimeCharts: boolean;
}

export interface GlobalSettings {
  theme: Theme;
  wakeLock: boolean;
  units: Unit;
}

export interface AllSettings {
  global: GlobalSettings;
  motion: MotionSettings;
  audio: AudioSettings;
  gps: GpsSettings;
}

export const DEFAULTS: AllSettings = {
  global: { theme: 'auto', wakeLock: true, units: 'si' },
  motion: {
    showLinear: true,
    showRaw: false,
    showGyro: false,
    showOrientation: false,
    showMagnitude: true,
    axisX: true, axisY: true, axisZ: true,
    timeWindowSec: 10,
    fftSize: 1024,
    fftWindow: 'hann',
    fftOverlapPct: 50,
    fftScaleLog: true,
    fftFreqLog: false,
    fftAutoScale: true,
    fftYMin: -120,
    fftYMax: 0,
    rmsWindowSec: 1,
    meanWindowSec: 5,
    peakHoldDecayDbPerSec: 0.5,
    dominantFreqCount: 5,
    showCube: false
  },
  audio: {
    showWaveform: true,
    showSpectrum: true,
    showSpectrogram: false,
    waveformWindowMs: 100,
    fftSize: 4096,
    fftWindow: 'hann',
    fftOverlapPct: 50,
    fftScaleLog: true,
    fftFreqLog: true,
    weighting: 'Z',
    calibration: {
      offsetDb: 0,
      method: 'none',
      referenceLevel: null,
      sigma: null,
      calibratedAt: null,
      audioConstraintsHash: null
    },
    rmsWindowSec: 1,
    dominantFreqCount: 5
  },
  gps: {
    coordFormat: 'decimal',
    movementThresholdMps: 0.5,
    showMap: true,
    showTimeCharts: true
  }
};

const STORAGE_KEY = 'sensor-lab.settings.v1';

function load(): AllSettings {
  if (typeof localStorage === 'undefined') return structuredClone(DEFAULTS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return mergeDeep(structuredClone(DEFAULTS), parsed) as AllSettings;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function mergeDeep<T>(target: T, src: unknown): T {
  if (typeof src !== 'object' || src === null) return target;
  for (const k of Object.keys(src as object)) {
    const sv = (src as Record<string, unknown>)[k];
    const tv = (target as Record<string, unknown>)[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object') {
      mergeDeep(tv, sv);
    } else {
      (target as Record<string, unknown>)[k] = sv;
    }
  }
  return target;
}

export const settings = writable<AllSettings>(load());

settings.subscribe((v) => {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch {}
  // apply theme to <html>
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = v.global.theme;
  }
});

export function resetSettings() { settings.set(structuredClone(DEFAULTS)); }

export function exportSettingsJson(): string {
  return JSON.stringify(get(settings), null, 2);
}

export function importSettingsJson(json: string) {
  try {
    const parsed = JSON.parse(json);
    settings.set(mergeDeep(structuredClone(DEFAULTS), parsed) as AllSettings);
  } catch (e) {
    throw new Error('Invalid settings JSON: ' + (e as Error).message);
  }
}

/** Update a slice of settings without recreating the whole object. */
export function updateMotion(patch: Partial<MotionSettings>) {
  settings.update((s) => ({ ...s, motion: { ...s.motion, ...patch } }));
}
export function updateAudio(patch: Partial<AudioSettings>) {
  settings.update((s) => ({ ...s, audio: { ...s.audio, ...patch } }));
}
export function updateGps(patch: Partial<GpsSettings>) {
  settings.update((s) => ({ ...s, gps: { ...s.gps, ...patch } }));
}
export function updateGlobal(patch: Partial<GlobalSettings>) {
  settings.update((s) => ({ ...s, global: { ...s.global, ...patch } }));
}
