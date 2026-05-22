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
 */
import { writable, get } from 'svelte/store';
import type { WindowName } from '$lib/dsp/windowing';
import type { FftSize } from '$lib/dsp/fft';
import type { Weighting } from '$lib/dsp/weighting';

export type Theme = 'dark' | 'light' | 'auto';
export type CoordFormat = 'decimal' | 'dms';
export type Unit = 'si' | 'imperial';
export type MapProvider = 'apple' | 'carto' | 'osm';

/** Per-KPI visibility — one toggle per displayed metric. */
export interface KpiVisibility {
  peak: boolean;
  rms: boolean;
  avg: boolean;
  crest: boolean;
  kurt: boolean;
  hold: boolean;
  pkpk: boolean;
}

export interface MotionSettings {
  showLinear: boolean;
  showRaw: boolean;
  showGyro: boolean;
  showOrientation: boolean;
  showMagnitude: boolean;
  // Note: axisX/Y/Z still live here for persistence, but inline toggles
  // on the chart page now write to them directly so the user doesn't
  // need to open Settings to flip an axis.
  axisX: boolean;
  axisY: boolean;
  axisZ: boolean;
  timeWindowSec: number;
  fftSize: FftSize;
  fftWindow: WindowName;
  fftOverlapPct: 0 | 25 | 50 | 75;
  fftScaleLog: boolean;
  fftFreqLog: boolean;
  fftAutoScale: boolean;
  fftYMin: number;
  fftYMax: number;
  rmsWindowSec: number;
  meanWindowSec: number;
  peakHoldDecayDbPerSec: number;
  dominantFreqCount: number;
  /** Exponential-smoothing factor for the dominant-freq magnitude EMA.
      0 = no smoothing (jittery), ~0.85 = heavily damped (stable). */
  dominantSmoothing: number;
  showCube: boolean;
  /** Per-KPI visibility for the Motion page. */
  kpiVisible: KpiVisibility;
}

export interface AudioSettings {
  showWaveform: boolean;
  showSpectrum: boolean;
  showSpectrogram: boolean;
  waveformWindowMs: 50 | 100 | 500 | 1000;
  fftSize: FftSize;
  fftWindow: WindowName;
  fftOverlapPct: 0 | 25 | 50 | 75;
  fftScaleLog: boolean;
  fftFreqLog: boolean;
  weighting: Weighting;
  calibration: {
    offsetDb: number;
    method: 'external' | 'sensitivity' | 'none';
    referenceLevel: number | null;
    sigma: number | null;
    calibratedAt: number | null;
    audioConstraintsHash: string | null;
  };
  rmsWindowSec: number;
  dominantFreqCount: number;
  dominantSmoothing: number;
  kpiVisible: KpiVisibility;
}

export interface GpsSettings {
  coordFormat: CoordFormat;
  movementThresholdMps: number;
  showMap: boolean;
  showTimeCharts: boolean;
  /** Tile / SDK provider for the map.
      - 'apple': MapKit JS — needs an Apple Developer JWT (set below).
        Falls back to 'carto' if no token is provided.
      - 'carto': CartoDB Voyager tiles — free, no token, closest to Apple Maps look.
      - 'osm': OpenStreetMap default tiles. */
  mapProvider: MapProvider;
  /** MapKit JS authorization JWT. See https://developer.apple.com/maps/web/. */
  appleMapsToken: string;
  kpiVisible: {
    distance: boolean;
    speedMax: boolean;
    speedMin: boolean;
    speedAvg: boolean;
    speedMedian: boolean;
    timeMoving: boolean;
    heading: boolean;
    accuracy: boolean;
  };
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
    dominantSmoothing: 0.85,
    showCube: false,
    kpiVisible: {
      peak: true, rms: true, avg: true, crest: true,
      kurt: true, hold: true, pkpk: true
    }
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
    dominantFreqCount: 5,
    dominantSmoothing: 0.9,
    kpiVisible: {
      peak: true, rms: true, avg: false, crest: true,
      kurt: false, hold: false, pkpk: false
    }
  },
  gps: {
    coordFormat: 'decimal',
    movementThresholdMps: 0.5,
    showMap: true,
    showTimeCharts: true,
    mapProvider: 'carto',
    appleMapsToken: '',
    kpiVisible: {
      distance: true, speedMax: true, speedMin: false, speedAvg: true,
      speedMedian: false, timeMoving: true, heading: true, accuracy: true
    }
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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* */ }
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

/** Patch a Motion KpiVisibility field. */
export function setMotionKpi(key: keyof KpiVisibility, value: boolean) {
  settings.update((s) => ({
    ...s,
    motion: { ...s.motion, kpiVisible: { ...s.motion.kpiVisible, [key]: value } }
  }));
}
export function setAudioKpi(key: keyof KpiVisibility, value: boolean) {
  settings.update((s) => ({
    ...s,
    audio: { ...s.audio, kpiVisible: { ...s.audio.kpiVisible, [key]: value } }
  }));
}
export function setGpsKpi(key: keyof GpsSettings['kpiVisible'], value: boolean) {
  settings.update((s) => ({
    ...s,
    gps: { ...s.gps, kpiVisible: { ...s.gps.kpiVisible, [key]: value } }
  }));
}
