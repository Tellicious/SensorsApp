/**
 * Logging-session store.
 *
 * Manages a single "currently recording" session at a time. Per the app
 * spec only one module logs at once; switching modules mid-session is
 * either confirmed or denied by the UI before this store is touched.
 *
 * Performance: writes are batched. The motion module emits ~60 samples/s;
 * inserting that many IndexedDB rows individually would saturate the main
 * thread. Instead we accumulate samples in memory and flush via
 * `bulkAdd` every 500 ms.
 *
 * Module-aware push helpers: `pushMotion` is a no-op unless the active
 * session is a motion session. Same for `pushGps`. The page code can
 * therefore call these unconditionally on every sensor sample.
 */
import { writable, get } from 'svelte/store';
import { db, type ModuleKind, type MotionSample, type GpsSample } from '$lib/storage/db';
import { get as getStore } from 'svelte/store';
import { settings } from './settings';

/** UI-visible state of the current logging session. */
export interface SessionState {
  active: boolean;
  module: ModuleKind | null;
  sessionId: number | null;
  startedAt: number;
  samplesWritten: number;
}

export const sessionState = writable<SessionState>({
  active: false,
  module: null,
  sessionId: null,
  startedAt: 0,
  samplesWritten: 0
});

// Pending sample buffers in memory. Sample pushes go here; the flush timer
// moves them to IndexedDB in one bulkAdd call every ~500 ms.
let motionBuf: MotionSample[] = [];
let gpsBuf: GpsSample[] = [];
let flushTimer: number | null = null;

/**
 * Drain both in-memory buffers into IndexedDB. Called by the 500 ms
 * interval timer and once on stop() to capture the final partial batch.
 */
async function flush() {
  if (motionBuf.length) {
    const b = motionBuf;
    motionBuf = [];
    await db.samples_motion.bulkAdd(b);
    sessionState.update((s) => ({ ...s, samplesWritten: s.samplesWritten + b.length }));
  }
  if (gpsBuf.length) {
    const b = gpsBuf;
    gpsBuf = [];
    await db.samples_gps.bulkAdd(b);
    sessionState.update((s) => ({ ...s, samplesWritten: s.samplesWritten + b.length }));
  }
}

/**
 * Begin a new logging session for the given module.
 * Throws if a session is already active — the UI is expected to confirm
 * stop-then-start before getting here.
 *
 * Returns the new session id (auto-incremented). The settings snapshot is
 * captured here so later analysis can reproduce the exact FFT / KPI / etc.
 * configuration that produced the data.
 */
export async function startLogging(module: ModuleKind): Promise<number> {
  const s = get(sessionState);
  if (s.active) throw new Error('Logging already active');
  const startedAt = Date.now();
  const settingsSnapshot = JSON.stringify(getStore(settings));
  const id = await db.sessions.add({
    module,
    startedAt,
    endedAt: null,
    settingsSnapshot
  });
  sessionState.set({
    active: true,
    module,
    sessionId: id,
    startedAt,
    samplesWritten: 0
  });
  if (flushTimer === null) {
    flushTimer = window.setInterval(flush, 500);
  }
  return id;
}

/**
 * End the current session. Flushes any pending samples to disk, stamps
 * endedAt on the session row, and clears the active state.
 */
export async function stopLogging(): Promise<void> {
  const s = get(sessionState);
  if (!s.active || s.sessionId === null) return;
  await flush();
  await db.sessions.update(s.sessionId, { endedAt: Date.now() });
  if (flushTimer !== null) { clearInterval(flushTimer); flushTimer = null; }
  sessionState.set({
    active: false,
    module: null,
    sessionId: null,
    startedAt: 0,
    samplesWritten: 0
  });
}

/**
 * Append a motion sample to the in-memory buffer. Cheap; safe to call
 * unconditionally. No-op when no motion session is active.
 */
export function pushMotion(s: Omit<MotionSample, 'id' | 'sessionId'>) {
  const st = get(sessionState);
  if (!st.active || st.module !== 'motion' || st.sessionId === null) return;
  motionBuf.push({ ...s, sessionId: st.sessionId });
}

/** GPS counterpart to pushMotion. */
export function pushGps(s: Omit<GpsSample, 'id' | 'sessionId'>) {
  const st = get(sessionState);
  if (!st.active || st.module !== 'gps' || st.sessionId === null) return;
  gpsBuf.push({ ...s, sessionId: st.sessionId });
}

/**
 * Log a pause or resume event against the active session.
 *
 * Called by the layout's visibilitychange handler so that long-running
 * recordings have explicit markers around gaps caused by the app being
 * backgrounded. Stored in IndexedDB (events table) and surfaced in the
 * CSV metadata header on export.
 *
 * No-op when no session is active. Awaitless (fire-and-forget) — pauses
 * happen at the worst moments and we don't want to add latency.
 */
export function logSessionEvent(type: 'pause' | 'resume', t: number = Date.now()): void {
  const st = get(sessionState);
  if (!st.active || st.sessionId === null) return;
  db.events.add({ sessionId: st.sessionId, t, type }).catch(() => { /* */ });
}
