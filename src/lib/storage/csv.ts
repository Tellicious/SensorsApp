/**
 * CSV / ZIP export for logged sessions.
 *
 * One session ⇒ one CSV file (each module has its own column schema, so we
 * never mix modules in a single file). Files have:
 *   - A `# comment` metadata header (session id, module, ISO timestamps,
 *     user agent, frozen settings snapshot)
 *   - One column-name row
 *   - One row per sample
 *
 * `downloadAllSessionsZip` bundles every session into a single ZIP with
 * one CSV per session, filenames stamped with module + timestamp.
 *
 * All export is local: data goes from IndexedDB → Blob → object URL →
 * a synthetic <a download> click. No network involved.
 */
import JSZip from 'jszip';
import { db, type Session, type ModuleKind } from './db';

/** Format an epoch-ms timestamp as ISO 8601 UTC. */
const ISO_UTC = (epochMs: number) => new Date(epochMs).toISOString();

/** Column order for Motion CSVs. */
const MOTION_COLS = [
  't_ms',                     // ms since session start
  'iso',                      // ISO 8601 wall-clock timestamp
  'ax', 'ay', 'az',           // m/s² linear (gravity removed)
  'axg', 'ayg', 'azg',        // m/s² raw (with gravity)
  'gx', 'gy', 'gz',           // deg/s gyroscope
  'ox', 'oy', 'oz'            // deg orientation (alpha/beta/gamma)
];

/** Column order for GPS CSVs. */
const GPS_COLS = [
  't_ms',
  'iso',
  'lat', 'lon',
  'alt_m', 'acc_h_m', 'acc_v_m',
  'heading_deg', 'speed_mps'
];

/**
 * Escape a single field for CSV per RFC 4180.
 *
 * Rules:
 * - null/undefined ⇒ empty string
 * - values containing comma, double-quote, or newline ⇒ wrapped in
 *   double-quotes with internal quotes doubled
 * - everything else passes through unchanged
 *
 * Exported (rather than kept private) so the unit tests can verify
 * the corner cases — commas, embedded quotes, newlines.
 */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return s;
}

/**
 * Build the leading `#`-prefixed metadata block. Lines start with `#` so
 * most CSV readers (pandas, Excel "comma" import) can skip them as comments
 * or as a single multi-line header.
 *
 * Pause/resume events (the app being backgrounded mid-session) are emitted
 * here so a post-hoc analysis can identify and account for the data gaps.
 */
async function metadataHeader(s: Session): Promise<string> {
  const lines = [
    `# Sensor Lab CSV export`,
    `# session_id: ${s.id}`,
    `# module: ${s.module}`,
    `# started_at: ${ISO_UTC(s.startedAt)}`,
    `# ended_at: ${s.endedAt ? ISO_UTC(s.endedAt) : 'null'}`,
    `# user_agent: ${navigator.userAgent}`
  ];
  try {
    const settings = JSON.parse(s.settingsSnapshot);
    lines.push(`# settings: ${JSON.stringify(settings)}`);
  } catch {
    // Settings snapshot was malformed JSON — preserve a truncated raw
    // copy so the export still tells the user *something*.
    lines.push(`# settings_raw: ${s.settingsSnapshot.slice(0, 500)}`);
  }
  // Pause/resume events for this session — useful when the app was
  // backgrounded mid-recording and there's a gap in samples.
  try {
    const events = await db.events.where('sessionId').equals(s.id!).toArray();
    if (events.length) {
      const compact = events.map((e) => ({
        t: e.t - s.startedAt,
        iso: ISO_UTC(e.t),
        type: e.type
      }));
      lines.push(`# pause_resume_events: ${JSON.stringify(compact)}`);
    }
  } catch { /* db missing, fine */ }
  return lines.join('\n') + '\n';
}

/**
 * Build the full CSV text (header + column names + rows) for one session.
 * Reads samples from the appropriate table based on `session.module`.
 * Async because it queries IndexedDB.
 */
export async function sessionToCsv(session: Session): Promise<string> {
  const header = await metadataHeader(session);
  const cols = session.module === 'motion' ? MOTION_COLS : GPS_COLS;
  const start = session.startedAt;

  let body = cols.join(',') + '\n';

  if (session.module === 'motion') {
    const rows = await db.samples_motion.where('sessionId').equals(session.id!).toArray();
    for (const r of rows) {
      body += [
        r.t,
        ISO_UTC(start + r.t),
        r.ax, r.ay, r.az,
        r.axg, r.ayg, r.azg,
        r.gx, r.gy, r.gz,
        r.ox, r.oy, r.oz
      ].map(csvEscape).join(',') + '\n';
    }
  } else if (session.module === 'gps') {
    const rows = await db.samples_gps.where('sessionId').equals(session.id!).toArray();
    for (const r of rows) {
      body += [
        r.t,
        ISO_UTC(start + r.t),
        r.lat, r.lon, r.alt, r.accH, r.accV, r.heading, r.speed
      ].map(csvEscape).join(',') + '\n';
    }
  }

  return header + body;
}

/** Zero-pad a positive integer to two digits ("3" → "03"). */
function pad(n: number) { return n.toString().padStart(2, '0'); }

/** Build a session filename: `<module>_YYYYMMDD_HHMMSS.csv`. */
function filename(module: ModuleKind, ts: number): string {
  const d = new Date(ts);
  return `${module}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.csv`;
}

/**
 * Generate a CSV for one session and trigger a browser download via the
 * synthetic anchor click pattern. All client-side; no upload anywhere.
 */
export async function downloadSessionCsv(session: Session): Promise<void> {
  const csv = await sessionToCsv(session);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename(session.module, session.startedAt);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has had time to process; otherwise iOS Safari
  // sometimes cancels the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Bundle every session in the database into a single ZIP and download it.
 * Inside the ZIP, each session is its own CSV with the standard filename.
 */
export async function downloadAllSessionsZip(): Promise<void> {
  const sessions = await db.sessions.toArray();
  if (sessions.length === 0) {
    alert('No sessions to export.');
    return;
  }
  const zip = new JSZip();
  for (const s of sessions) {
    const csv = await sessionToCsv(s);
    zip.file(filename(s.module, s.startedAt), csv);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  a.download = `sensor-lab_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
