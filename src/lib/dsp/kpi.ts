// Online, resettable KPI calculators. Each tracker maintains state and
// updates in O(1) per sample (where possible). Buffers are pre-allocated.

/** Tracks running peak (max abs), peak-to-peak, with optional reset. */
export class PeakTracker {
  peak = 0;
  min = +Infinity;
  max = -Infinity;
  push(v: number) {
    const a = Math.abs(v);
    if (a > this.peak) this.peak = a;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }
  get peakToPeak() { return (this.max === -Infinity || this.min === +Infinity) ? 0 : this.max - this.min; }
  reset() { this.peak = 0; this.min = +Infinity; this.max = -Infinity; }
}

/**
 * Peak-hold with linear-dB decay. Internally holds a linear amplitude
 * and decays it by `decayDbPerSec * dt` (converted dB → linear factor)
 * between successive samples. New peaks reset the decay anchor.
 *
 * Time `t` is in milliseconds (same scale as `performance.now()`).
 */
export class PeakHold {
  hold = 0;
  decayDbPerSec: number;
  /** −1 sentinel marks "not yet sampled" — distinguished from t=0. */
  private lastT = -1;
  constructor(decayDbPerSec = 0.5) {
    this.decayDbPerSec = decayDbPerSec;
  }
  push(v: number, t: number) {
    const a = Math.abs(v);
    // First sample after construction/reset has no defined dt yet.
    const dt = this.lastT < 0 ? 0 : Math.max(0, (t - this.lastT) / 1000);
    this.lastT = t;
    // dB → linear decay factor over `dt` seconds
    const factor = Math.pow(10, -this.decayDbPerSec * dt / 20);
    this.hold = Math.max(this.hold * factor, a);
  }
  reset() { this.hold = 0; this.lastT = -1; }
}

/**
 * Sliding-window RMS over the last `windowSec` of samples.
 * Uses a circular buffer of squared values plus a running sum.
 */
export class RollingRms {
  private buf: Float64Array;
  private times: Float64Array;
  private head = 0;
  private filled = false;
  private sumSq = 0;
  private count = 0;
  private windowMs: number;

  constructor(capacity: number, windowSec: number) {
    this.buf = new Float64Array(capacity);
    this.times = new Float64Array(capacity);
    this.windowMs = windowSec * 1000;
  }

  push(v: number, t: number) {
    if (this.filled) {
      // remove tail until it fits, in case window is shorter than buffer
      // (best-effort O(1) amortized)
      this.sumSq -= this.buf[this.head];
    }
    this.buf[this.head] = v * v;
    this.times[this.head] = t;
    this.sumSq += v * v;
    this.head++;
    if (this.head >= this.buf.length) { this.head = 0; this.filled = true; }
    this.count = this.filled ? this.buf.length : this.head;

    // drop samples older than windowMs
    const cutoff = t - this.windowMs;
    let scanned = 0;
    while (scanned < this.count) {
      // tail index
      const tail = this.filled
        ? (this.head + (this.buf.length - this.count) + scanned) % this.buf.length
        : scanned;
      if (this.times[tail] >= cutoff) break;
      this.sumSq -= this.buf[tail];
      scanned++;
    }
    // ...note: we don't physically remove, just adjust count for RMS
    this.count -= scanned;
    if (this.count < 0) this.count = 0;
  }

  get rms() {
    return this.count > 0 ? Math.sqrt(this.sumSq / this.count) : 0;
  }
  reset() {
    this.head = 0; this.filled = false; this.sumSq = 0; this.count = 0;
    this.buf.fill(0); this.times.fill(0);
  }
  setWindow(sec: number) { this.windowMs = sec * 1000; }
}

/**
 * Rolling arithmetic mean over the last `windowSec`. Implementation mirrors
 * RollingRms but without the square — kept separate for clarity.
 */
export class RollingMean {
  private buf: Float64Array;
  private times: Float64Array;
  private head = 0;
  private filled = false;
  private sum = 0;
  private count = 0;
  private windowMs: number;

  constructor(capacity: number, windowSec: number) {
    this.buf = new Float64Array(capacity);
    this.times = new Float64Array(capacity);
    this.windowMs = windowSec * 1000;
  }

  push(v: number, t: number) {
    if (this.filled) this.sum -= this.buf[this.head];
    this.buf[this.head] = v;
    this.times[this.head] = t;
    this.sum += v;
    this.head++;
    if (this.head >= this.buf.length) { this.head = 0; this.filled = true; }
    this.count = this.filled ? this.buf.length : this.head;

    const cutoff = t - this.windowMs;
    let scanned = 0;
    while (scanned < this.count) {
      const tail = this.filled
        ? (this.head + (this.buf.length - this.count) + scanned) % this.buf.length
        : scanned;
      if (this.times[tail] >= cutoff) break;
      this.sum -= this.buf[tail];
      scanned++;
    }
    this.count -= scanned;
    if (this.count < 0) this.count = 0;
  }

  get mean() { return this.count > 0 ? this.sum / this.count : 0; }
  reset() {
    this.head = 0; this.filled = false; this.sum = 0; this.count = 0;
    this.buf.fill(0); this.times.fill(0);
  }
  setWindow(sec: number) { this.windowMs = sec * 1000; }
}

/** Kurtosis (excess) over a sliding window — recomputed from circular buffer. */
export class RollingKurtosis {
  private buf: Float64Array;
  private head = 0;
  private filled = false;
  capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
  }

  push(v: number) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.filled = true;
  }

  get kurtosis() {
    const n = this.filled ? this.capacity : this.head;
    if (n < 4) return 0;
    let m = 0;
    for (let i = 0; i < n; i++) m += this.buf[i];
    m /= n;
    let m2 = 0, m4 = 0;
    for (let i = 0; i < n; i++) {
      const d = this.buf[i] - m;
      const d2 = d * d;
      m2 += d2;
      m4 += d2 * d2;
    }
    m2 /= n; m4 /= n;
    return m2 > 0 ? (m4 / (m2 * m2)) - 3 : 0;
  }

  reset() { this.head = 0; this.filled = false; this.buf.fill(0); }
}

/** Bundle of trackers for a single scalar signal. */
export class ChannelStats {
  peak = new PeakTracker();
  peakHold: PeakHold;
  rms: RollingRms;
  mean: RollingMean;
  kurt: RollingKurtosis;

  constructor(opts: {
    capacity: number;
    rmsWindowSec: number;
    meanWindowSec: number;
    peakHoldDecayDbPerSec: number;
  }) {
    this.peakHold = new PeakHold(opts.peakHoldDecayDbPerSec);
    this.rms = new RollingRms(opts.capacity, opts.rmsWindowSec);
    this.mean = new RollingMean(opts.capacity, opts.meanWindowSec);
    this.kurt = new RollingKurtosis(opts.capacity);
  }

  push(v: number, t: number) {
    this.peak.push(v);
    this.peakHold.push(v, t);
    this.rms.push(v, t);
    this.mean.push(v, t);
    this.kurt.push(v);
  }

  get crestFactor() {
    const r = this.rms.rms;
    return r > 0 ? this.peak.peak / r : 0;
  }

  reset() {
    this.peak.reset();
    this.peakHold.reset();
    this.rms.reset();
    this.mean.reset();
    this.kurt.reset();
  }
}
