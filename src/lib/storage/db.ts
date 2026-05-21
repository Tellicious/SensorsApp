/**
 * IndexedDB schema (via Dexie).
 *
 * Stores three table types:
 *   - sessions:        one row per Start→Stop logging session
 *   - samples_motion:  raw motion samples belonging to a motion session
 *   - samples_gps:     raw gps samples belonging to a gps session
 *   - kpi_snapshots:   point-in-time KPI captures (reserved for future use)
 *
 * Audio sessions are NOT stored — the audio module is visualization-only by
 * design (storing 48 kHz raw audio would chew through iOS IndexedDB quota
 * in minutes).
 *
 * The schema is versioned to allow non-destructive migrations later.
 */
import Dexie, { type Table } from 'dexie';

/** Module that logged a session. Audio has no sessions. */
export type ModuleKind = 'motion' | 'gps';

/** Session header row. One per logging run. */
export interface Session {
  id?: number;
  module: ModuleKind;
  /** Epoch ms when Start was tapped (the t=0 reference for sample.t). */
  startedAt: number;
  /** Epoch ms when Stop was tapped, or null if still active. */
  endedAt: number | null;
  /** Frozen JSON snapshot of all user settings at Start time. */
  settingsSnapshot: string;
  note?: string;
}

/** One row of `samples_motion`. Times are ms-since-session-start. */
export interface MotionSample {
  id?: number;
  sessionId: number;
  /** ms since session.startedAt */
  t: number;
  /** Linear acceleration (gravity removed), m/s². */
  ax: number; ay: number; az: number;
  /** Raw acceleration including gravity, m/s². */
  axg: number; ayg: number; azg: number;
  /** Rotation rate (gyro), deg/s. */
  gx: number; gy: number; gz: number;
  /** Orientation latched from deviceorientation, deg. */
  ox: number; oy: number; oz: number;
}

/** One row of `samples_gps`. */
export interface GpsSample {
  id?: number;
  sessionId: number;
  t: number;
  lat: number; lon: number;
  alt: number | null;
  accH: number | null;
  accV: number | null;
  heading: number | null;
  speed: number | null;
}

/** Reserved for future use — point-in-time KPI snapshot at user-initiated reset. */
export interface KpiSnapshot {
  id?: number;
  sessionId: number;
  t: number;
  kpiName: string;
  value: number;
}

/** Pause/resume events recorded against a session. Used to mark gaps. */
export interface SessionEvent {
  id?: number;
  sessionId: number;
  /** Wall-clock epoch ms when the event happened. */
  t: number;
  /** 'pause' = app went background; 'resume' = back to foreground. */
  type: 'pause' | 'resume';
}

/**
 * Dexie subclass that declares the tables. The string after each
 * table name lists indexed columns. `++id` means auto-increment primary
 * key; other entries are secondary indexes that speed up `where()` queries.
 *
 * Schema versions are append-only; never edit a v1 store after release —
 * add v2/v3 migrations instead so users upgrading don't lose data.
 */
class SensorDb extends Dexie {
  sessions!: Table<Session, number>;
  samples_motion!: Table<MotionSample, number>;
  samples_gps!: Table<GpsSample, number>;
  kpi_snapshots!: Table<KpiSnapshot, number>;
  events!: Table<SessionEvent, number>;

  constructor() {
    super('sensor-lab');
    // v1 — initial schema
    this.version(1).stores({
      sessions: '++id, module, startedAt',
      samples_motion: '++id, sessionId, t',
      samples_gps: '++id, sessionId, t',
      kpi_snapshots: '++id, sessionId, t'
    });
    // v2 — add pause/resume events table. No data migration needed.
    this.version(2).stores({
      sessions: '++id, module, startedAt',
      samples_motion: '++id, sessionId, t',
      samples_gps: '++id, sessionId, t',
      kpi_snapshots: '++id, sessionId, t',
      events: '++id, sessionId, t'
    });
  }
}

/** Singleton database handle. Import directly in callers. */
export const db = new SensorDb();

/**
 * Return current IndexedDB usage and quota from the browser, in bytes.
 * Returns null on browsers that don't implement the Storage API
 * (mainly older Safari builds).
 */
export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!('storage' in navigator) || !navigator.storage.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

/**
 * Drop the entire database and reopen empty. Used by Settings → Wipe.
 * Awaiting open() ensures the next operation finds the fresh schema.
 */
export async function wipe(): Promise<void> {
  await db.delete();
  await db.open();
}
