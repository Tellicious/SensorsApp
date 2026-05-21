/**
 * Motion sensor wrapper.
 *
 * Subscribes to `devicemotion` (acceleration + gyro) and `deviceorientation`
 * (yaw / pitch / roll latched), merges them into a single MotionSample stream,
 * and exposes a measured-Hz estimate.
 *
 * iOS 13+ requires `DeviceMotionEvent.requestPermission()` to be invoked from
 * inside a user-gesture handler before any events will fire. The
 * `requestMotionPermission` helper takes care of the platform branching.
 */

/**
 * One combined motion sample. Every numeric field is in SI units; any null
 * value from the underlying browser event is coerced to 0 so downstream DSP
 * doesn't need null-checks on hot paths.
 */
export interface MotionSample {
  /** Timestamp from `performance.now()` (ms, monotonic, fractional). */
  t: number;
  /** Linear acceleration, gravity removed, m/s². */
  ax: number; ay: number; az: number;
  /** Raw acceleration including gravity, m/s². */
  axg: number; ayg: number; azg: number;
  /** Rotation rate from the gyroscope, deg/s. */
  gx: number; gy: number; gz: number;
  /** Orientation Euler angles (alpha/beta/gamma) in deg,
   *  latched from the most recent `deviceorientation` event. */
  ox: number; oy: number; oz: number;
}

export type MotionCallback = (s: MotionSample) => void;

/** Coerce nullable/NaN browser values to 0 so DSP code can assume finite numbers. */
const NaNable = (v: number | null | undefined): number =>
  v === null || v === undefined || Number.isNaN(v) ? 0 : v;

/**
 * True on iOS 13+ Safari, where `DeviceMotionEvent.requestPermission()` exists
 * and must be invoked from a user-gesture handler before events fire.
 */
function needsIosPermission(): boolean {
  const D = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
  return typeof D?.requestPermission === 'function';
}

/**
 * Request permission for devicemotion on platforms that gate it (iOS).
 *
 * Must be called from inside a user-gesture handler — invoking it from
 * onMount or a timer will be silently denied by Safari.
 *
 * Returns:
 *   - 'granted'      → events will be delivered after start()
 *   - 'denied'       → user said no, or iOS Motion & Orientation Access is OFF
 *   - 'unsupported'  → DeviceMotionEvent doesn't exist at all
 */
export async function requestMotionPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!needsIosPermission()) {
    // Non-iOS: no explicit permission. We still need the event to exist.
    if (typeof DeviceMotionEvent === 'undefined') return 'unsupported';
    return 'granted';
  }
  const D = DeviceMotionEvent as unknown as { requestPermission: () => Promise<string> };
  try {
    const res = await D.requestPermission();
    return res === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/**
 * Public interface for a running motion controller. Start with a callback,
 * stop to release listeners. `hz` is updated once per second with the
 * observed event rate (typically 60 Hz on iOS Safari).
 */
export interface MotionController {
  start(cb: MotionCallback): void;
  stop(): void;
  /** Best estimate of the actual sample rate in Hz, refreshed every ~1 s. */
  readonly hz: number;
  readonly running: boolean;
}

/**
 * Factory: build a fresh controller. Stateless beyond the closures below;
 * a single controller can be start/stop'd repeatedly.
 */
export function createMotionController(): MotionController {
  let cb: MotionCallback | null = null;
  let running = false;
  let hz = 0;
  let samplesInSec = 0;
  let lastSecond = 0;

  // Latched orientation — `deviceorientation` and `devicemotion` are separate
  // events; we keep the latest orientation values around and stamp them into
  // every motion sample so consumers see one unified stream.
  let ox = 0, oy = 0, oz = 0;

  const onOrient = (e: DeviceOrientationEvent) => {
    ox = NaNable(e.alpha);
    oy = NaNable(e.beta);
    oz = NaNable(e.gamma);
  };

  const onMotion = (e: DeviceMotionEvent) => {
    if (!cb) return;
    const t = performance.now();
    // Update Hz estimate once per wall-clock second
    const second = Math.floor(t / 1000);
    if (second !== lastSecond) {
      hz = samplesInSec;
      samplesInSec = 0;
      lastSecond = second;
    }
    samplesInSec++;

    const a = e.acceleration;
    const ag = e.accelerationIncludingGravity;
    const r = e.rotationRate;

    cb({
      t,
      ax: NaNable(a?.x), ay: NaNable(a?.y), az: NaNable(a?.z),
      axg: NaNable(ag?.x), ayg: NaNable(ag?.y), azg: NaNable(ag?.z),
      gx: NaNable(r?.alpha), gy: NaNable(r?.beta), gz: NaNable(r?.gamma),
      ox, oy, oz
    });
  };

  return {
    start(callback) {
      if (running) return;
      cb = callback;
      window.addEventListener('devicemotion', onMotion);
      window.addEventListener('deviceorientation', onOrient);
      running = true;
      lastSecond = Math.floor(performance.now() / 1000);
    },
    stop() {
      window.removeEventListener('devicemotion', onMotion);
      window.removeEventListener('deviceorientation', onOrient);
      cb = null;
      running = false;
      hz = 0;
      samplesInSec = 0;
    },
    get hz() { return hz; },
    get running() { return running; }
  };
}
