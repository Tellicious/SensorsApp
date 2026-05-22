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
    const dt = this.lastT < 0 ? 0 : Math.max(0, (t - this.lastT) / 1000);
    this.lastT = t;
    const factor = Math.pow(10, -this.decayDbPerSec * dt / 20);
    this.hold = Math.max(this.hold * factor, a);
  }
  reset() { this.hold = 0; this.lastT = -1; }
}

/**
 * Sliding-window RMS over the last `windowSec` of samples.
 *
 * Implementation: explicit (head, tail, count) pointers into a circular
 * Float64Array. On every push:
 *   1. If the buffer is full at capacity, drop one from tail.
 *   2. Append the new squared value at head, advance head.
 *   3. Advance tail past any entries older than (t − windowMs).
 *
 * Numerical safety: floating-point cancellation in the running sum can
 * accumulate; we clamp tiny negatives to 0. After ~1M samples we also
 * trigger a full recompute to avoid drift.
 *
 * History: the previous implementation conflated "buffer count" with
 * "in-window count" and produced negative sums after ~1 s of acquisition,
 * which is why RMS / Crest read 0 or NaN and per-axis Avg showed wild
 * numbers like 1000 m/s² in the UI.
 */
export class RollingRms {
  private buf: Float64Array;
  private times: Float64Array;
  private capacity: number;
  private head = 0;
  private tail = 0;
  private count = 0;
  private sumSq = 0;
  private windowMs: number;
  private sinceCompact = 0;

  constructor(capacity: number, windowSec: number) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
    this.times = new Float64Array(capacity);
    this.windowMs = windowSec * 1000;
  }

  push(v: number, t: number) {
    const sq = v * v;
    this.buf[this.head] = sq;
    this.times[this.head] = t;
    this.sumSq += sq;
    this.head = (this.head + 1) % this.capacity;
    this.count++;

    // Buffer overflow: drop oldest
    if (this.count > this.capacity) {
      this.sumSq -= this.buf[this.tail];
      this.tail = (this.tail + 1) % this.capacity;
      this.count = this.capacity;
    }

    // Drop samples older than the window
    const cutoff = t - this.windowMs;
    while (this.count > 0 && this.times[this.tail] < cutoff) {
      this.sumSq -= this.buf[this.tail];
      this.tail = (this.tail + 1) % this.capacity;
      this.count--;
    }

    // FP safety
    if (this.sumSq < 0) this.sumSq = 0;

    // Periodic recompute to defeat drift on long runs
    if (++this.sinceCompact > 100000) this.recompact();
  }

  private recompact() {
    let s = 0;
    let i = this.tail;
    for (let k = 0; k < this.count; k++) {
      s += this.buf[i];
      i = (i + 1) % this.capacity;
    }
    this.sumSq = Math.max(0, s);
    this.sinceCompact = 0;
  }

  get rms() {
    return this.count > 0 ? Math.sqrt(this.sumSq / this.count) : 0;
  }
  reset() {
    this.head = 0; this.tail = 0; this.count = 0;
    this.sumSq = 0; this.sinceCompact = 0;
    this.buf.fill(0); this.times.fill(0);
  }
  setWindow(sec: number) { this.windowMs = sec * 1000; }
}

/**
 * Sliding-window arithmetic mean. Mirrors RollingRms exactly except
 * the buffer stores raw values, not squares.
 */
export class RollingMean {
  private buf: Float64Array;
  private times: Float64Array;
  private capacity: number;
  private head = 0;
  private tail = 0;
  private count = 0;
  private sum = 0;
  private windowMs: number;
  private sinceCompact = 0;

  constructor(capacity: number, windowSec: number) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
    this.times = new Float64Array(capacity);
    this.windowMs = windowSec * 1000;
  }

  push(v: number, t: number) {
    this.buf[this.head] = v;
    this.times[this.head] = t;
    this.sum += v;
    this.head = (this.head + 1) % this.capacity;
    this.count++;

    if (this.count > this.capacity) {
      this.sum -= this.buf[this.tail];
      this.tail = (this.tail + 1) % this.capacity;
      this.count = this.capacity;
    }

    const cutoff = t - this.windowMs;
    while (this.count > 0 && this.times[this.tail] < cutoff) {
      this.sum -= this.buf[this.tail];
      this.tail = (this.tail + 1) % this.capacity;
      this.count--;
    }

    if (++this.sinceCompact > 100000) this.recompact();
  }

  private recompact() {
    let s = 0;
    let i = this.tail;
    for (let k = 0; k < this.count; k++) {
      s += this.buf[i];
      i = (i + 1) % this.capacity;
    }
    this.sum = s;
    this.sinceCompact = 0;
  }

  get mean() { return this.count > 0 ? this.sum / this.count : 0; }
  reset() {
    this.head = 0; this.tail = 0; this.count = 0;
    this.sum = 0; this.sinceCompact = 0;
    this.buf.fill(0); this.times.fill(0);
  }
  setWindow(sec: number) { this.windowMs = sec * 1000; }
}

/**
 * Excess kurtosis over a sliding sample-count window — recomputed from
 * the circular buffer on read. Capacity defines the window length; the
 * default of 256 covers ~4 s at 60 Hz which keeps the statistic responsive.
 *
 * The previous default capacity of 4096 (~68 s at 60 Hz) effectively
 * never released old outliers, so a single transient at the start of an
 * acquisition kept the displayed kurtosis high forever.
 */
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
    /** Sample-count window for kurtosis. Defaults to min(256, capacity)
        so the statistic stays responsive — capacity is set to be large
        enough for the longest FFT, which is far too long for kurtosis. */
    kurtosisCapacity?: number;
  }) {
    this.peakHold = new PeakHold(opts.peakHoldDecayDbPerSec);
    this.rms = new RollingRms(opts.capacity, opts.rmsWindowSec);
    this.mean = new RollingMean(opts.capacity, opts.meanWindowSec);
    this.kurt = new RollingKurtosis(opts.kurtosisCapacity ?? Math.min(256, opts.capacity));
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
