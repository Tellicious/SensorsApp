<!--
  Motion module page.

  Provides the full Motion experience end-to-end:
  - Permission request flow (iOS gates devicemotion behind a user gesture)
  - Live time-domain chart for the linear-acceleration magnitude |a|
  - Live FFT chart with selectable size / window / overlap
  - Six live KPI tiles for |a|: peak, RMS, crest, kurtosis, peak-hold, pk-pk
  - List of N dominant frequencies extracted from the latest FFT frame
  - Bottom toolbar with Start/Stop/Reset/Log/CSV

  Performance: samples land in pre-allocated Float64Array circular buffers
  (no array.push, no GC pressure). FFT is recomputed only every "hop"
  samples (hop = fftSize * (1 - overlap/100)). The DOM tick refresh runs
  at 10 Hz; uPlot charts internally throttle at ~30 fps.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { settings, updateMotion } from '$lib/stores/settings';
  import { sessionState, pushMotion } from '$lib/stores/session';
  import {
    createMotionController, requestMotionPermission, type MotionSample
  } from '$lib/sensors/motion';
  import { ChannelStats } from '$lib/dsp/kpi';
  import { FftProcessor, dominantFrequencies, FFT_SIZES } from '$lib/dsp/fft';
  import { WINDOW_NAMES } from '$lib/dsp/windowing';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import TimeChart from '$lib/components/TimeChart.svelte';
  import FftChart from '$lib/components/FftChart.svelte';
  import FooterControls from '$lib/components/FooterControls.svelte';
  import OrientationCube from '$lib/components/OrientationCube.svelte';

  // ---- Buffer config ----------------------------------------------------
  // 4096 samples covers ~68 s at 60 Hz, which is more than the longest UI
  // time window (60 s) and more than the largest practical FFT (4096).
  const CAP = 4096;
  const xs = new Float64Array(CAP);   // sample timestamps in seconds (relative)
  // Linear acceleration (gravity removed)
  const ax = new Float64Array(CAP);
  const ay = new Float64Array(CAP);
  const az = new Float64Array(CAP);
  const am = new Float64Array(CAP);   // magnitude |a|
  // Raw acceleration (with gravity)
  const axg = new Float64Array(CAP);
  const ayg = new Float64Array(CAP);
  const azg = new Float64Array(CAP);
  // Gyroscope (deg/s)
  const gx = new Float64Array(CAP);
  const gy = new Float64Array(CAP);
  const gz = new Float64Array(CAP);
  // Orientation (deg)
  const ox = new Float64Array(CAP);
  const oy = new Float64Array(CAP);
  const oz = new Float64Array(CAP);
  let count = $state(0);
  let head = 0;
  let t0 = 0; // first-sample timestamp anchor (performance.now())

  // ---- Latest orientation (for the optional 3D cube) -------------------
  // These are reactive — updates flow through to OrientationCube which
  // re-applies the pose on every change. Updated at full sample rate, but
  // the cube's own RAF loop is what actually paints, so this is cheap.
  let orientation = $state({ alpha: 0, beta: 0, gamma: 0 });

  // ---- Sensor controller ------------------------------------------------
  const ctrl = createMotionController();
  let running = $state(false);
  let permission = $state<'unknown' | 'granted' | 'denied' | 'unsupported'>('unknown');
  let hz = $state(0);
  let hzTimer: number | null = null;

  // ---- KPI trackers -----------------------------------------------------
  /**
   * Build a fresh ChannelStats bundle with current user-settings windows.
   * Called on Start and whenever the relevant settings change.
   */
  function makeStats() {
    const s = $state.snapshot($settings).motion;
    return new ChannelStats({
      capacity: CAP,
      rmsWindowSec: s.rmsWindowSec,
      meanWindowSec: s.meanWindowSec,
      peakHoldDecayDbPerSec: s.peakHoldDecayDbPerSec
    });
  }
  // $state.raw — we don't need deep reactivity on these class instances;
  // we re-render display via the `tick` counter below.
  let statsX = $state.raw(makeStats());
  let statsY = $state.raw(makeStats());
  let statsZ = $state.raw(makeStats());
  let statsM = $state.raw(makeStats());
  /** UI refresh counter, incremented every 100 ms via setInterval. */
  let tick = $state(0);

  // ---- FFT --------------------------------------------------------------
  let fft: FftProcessor | null = null;
  let fftMag = $state<Float32Array>(new Float32Array(1));
  let fftDb = $state<Float32Array>(new Float32Array(1));
  let fftFreqs = $state<Float32Array>(new Float32Array(1));
  let dominant = $state<Array<{ freq: number; mag: number }>>([]);
  let sampleHopCounter = 0;

  /**
   * Build a new FFT processor with the current settings + measured sample
   * rate. Skips work if neither size nor rate changed.
   */
  function ensureFft() {
    const s = $settings.motion;
    if (!fft || fft.size !== s.fftSize || fft.sampleRate !== Math.max(hz || 60, 1)) {
      const rate = hz || 60;
      fft = new FftProcessor({
        size: s.fftSize,
        window: s.fftWindow,
        overlapPct: s.fftOverlapPct,
        sampleRate: rate
      });
      fftMag = new Float32Array(fft.bins);
      fftDb = new Float32Array(fft.bins);
      fftFreqs = fft.freqs;
    }
  }

  /**
   * Pull the most recent fftSize samples of |a| and compute the spectrum.
   * Updates `fftMag`, `fftDb`, and the `dominant` list of top peaks.
   */
  function computeFft() {
    if (!fft || count < fft.size) return;
    const N = fft.size;
    const frame = new Float32Array(N);
    for (let i = 0; i < N; i++) frame[i] = am[count - N + i];
    fft.compute(frame, fftMag, fftDb);
    const s = $settings.motion;
    dominant = dominantFrequencies(fftMag, fft.freqs, s.dominantFreqCount);
    fftMag = fftMag;   // self-assign forces reactivity
    fftDb = fftDb;
  }

  // ---- Sample callback --------------------------------------------------
  /**
   * Called by the motion controller for every devicemotion event.
   * Appends to the circular buffers, updates KPIs, kicks FFT when due,
   * and forwards to the logging session if active.
   */
  function onSample(s: MotionSample) {
    if (t0 === 0) t0 = s.t;
    const tSec = (s.t - t0) / 1000;
    const mag = Math.hypot(s.ax, s.ay, s.az);
    // Append (circular: shift-left once at capacity)
    if (count < CAP) {
      const i = count++;
      xs[i] = tSec;
      ax[i] = s.ax;   ay[i] = s.ay;   az[i] = s.az;   am[i] = mag;
      axg[i] = s.axg; ayg[i] = s.ayg; azg[i] = s.azg;
      gx[i] = s.gx;   gy[i] = s.gy;   gz[i] = s.gz;
      ox[i] = s.ox;   oy[i] = s.oy;   oz[i] = s.oz;
    } else {
      // Slide every buffer one slot left. copyWithin is O(n) but happens
      // exactly once per sample at saturation, and it's still bytecode-fast.
      const slots = [xs, ax, ay, az, am, axg, ayg, azg, gx, gy, gz, ox, oy, oz];
      for (const b of slots) b.copyWithin(0, 1);
      const i = CAP - 1;
      xs[i] = tSec;
      ax[i] = s.ax;   ay[i] = s.ay;   az[i] = s.az;   am[i] = mag;
      axg[i] = s.axg; ayg[i] = s.ayg; azg[i] = s.azg;
      gx[i] = s.gx;   gy[i] = s.gy;   gz[i] = s.gz;
      ox[i] = s.ox;   oy[i] = s.oy;   oz[i] = s.oz;
    }
    head = count;

    // KPI trackers operate on linear acceleration + magnitude.
    // (Raw / gyro / orientation get charts but not per-axis KPI tiles —
    //  linear acceleration is the headline channel for motion analysis.)
    statsX.push(s.ax, s.t);
    statsY.push(s.ay, s.t);
    statsZ.push(s.az, s.t);
    statsM.push(mag, s.t);

    // Latest orientation for the 3D cube. Reactive write — Svelte batches
    // this with the next render tick, so it's safe at 60 Hz.
    orientation = { alpha: s.ox, beta: s.oy, gamma: s.oz };

    // FFT every `hop` samples, where hop = size * (1 - overlap%)
    if (fft) {
      const hop = Math.max(1, Math.floor(fft.size * (1 - $settings.motion.fftOverlapPct / 100)));
      sampleHopCounter++;
      if (sampleHopCounter >= hop) {
        sampleHopCounter = 0;
        computeFft();
      }
    }

    // Stream to the logger (no-op if logging isn't active or wrong module)
    pushMotion({
      t: Math.floor(s.t - t0),
      ax: s.ax, ay: s.ay, az: s.az,
      axg: s.axg, ayg: s.ayg, azg: s.azg,
      gx: s.gx, gy: s.gy, gz: s.gz,
      ox: s.ox, oy: s.oy, oz: s.oz
    });
  }

  // ---- Start / Stop -----------------------------------------------------
  /**
   * Start acquisition. MUST be invoked from a user-gesture handler on
   * iOS — DeviceMotionEvent.requestPermission() requires it. Resets all
   * state then starts the underlying controller.
   */
  async function start() {
    permission = await requestMotionPermission();
    if (permission !== 'granted') return;
    ensureFft();
    t0 = 0;
    count = 0; head = 0;
    statsX.reset(); statsY.reset(); statsZ.reset(); statsM.reset();
    ctrl.start(onSample);
    running = true;
    hzTimer = window.setInterval(() => {
      hz = ctrl.hz;
      if (fft && Math.abs(fft.sampleRate - (hz || 60)) > 5) ensureFft();
      tick++;
    }, 250);
  }

  function stop() {
    ctrl.stop();
    running = false;
    if (hzTimer !== null) { clearInterval(hzTimer); hzTimer = null; }
  }
  function resetKpi() {
    statsX.reset(); statsY.reset(); statsZ.reset(); statsM.reset();
  }
  onDestroy(stop);

  // KPI display ticker — keeps card values fresh even when no settings change
  let displayInterval: number;
  onMount(() => {
    displayInterval = window.setInterval(() => tick++, 100);
    return () => clearInterval(displayInterval);
  });

  // ---- Chart series ----------------------------------------------------
  const COLOR_X = 'var(--series-3)';
  const COLOR_Y = 'var(--series-2)';
  const COLOR_Z = 'var(--series-1)';
  const COLOR_M = 'var(--series-4)';
  const COLOR_SPEC = 'var(--tint)';

  /**
   * Channel groups built from the user's settings. Each entry produces one
   * TimeChart in the template. Per-axis toggles apply within a group.
   * Each group has its own unit label.
   */
  interface ChannelGroup {
    key: string;
    label: string;
    unit: string;
    ys: Float64Array[];
    defs: Array<{ label: string; color: string }>;
  }
  let channelGroups = $derived.by<ChannelGroup[]>(() => {
    const s = $settings.motion;
    const groups: ChannelGroup[] = [];
    if (s.showLinear) {
      const ys: Float64Array[] = []; const defs: Array<{ label: string; color: string }> = [];
      if (s.axisX) { ys.push(ax); defs.push({ label: 'x', color: COLOR_X }); }
      if (s.axisY) { ys.push(ay); defs.push({ label: 'y', color: COLOR_Y }); }
      if (s.axisZ) { ys.push(az); defs.push({ label: 'z', color: COLOR_Z }); }
      if (s.showMagnitude) { ys.push(am); defs.push({ label: '|a|', color: COLOR_M }); }
      if (ys.length) groups.push({ key: 'linear', label: 'Linear acceleration', unit: 'm/s²', ys, defs });
    }
    if (s.showRaw) {
      const ys: Float64Array[] = []; const defs: Array<{ label: string; color: string }> = [];
      if (s.axisX) { ys.push(axg); defs.push({ label: 'x', color: COLOR_X }); }
      if (s.axisY) { ys.push(ayg); defs.push({ label: 'y', color: COLOR_Y }); }
      if (s.axisZ) { ys.push(azg); defs.push({ label: 'z', color: COLOR_Z }); }
      if (ys.length) groups.push({ key: 'raw', label: 'Raw (with gravity)', unit: 'm/s²', ys, defs });
    }
    if (s.showGyro) {
      const ys: Float64Array[] = []; const defs: Array<{ label: string; color: string }> = [];
      if (s.axisX) { ys.push(gx); defs.push({ label: 'x', color: COLOR_X }); }
      if (s.axisY) { ys.push(gy); defs.push({ label: 'y', color: COLOR_Y }); }
      if (s.axisZ) { ys.push(gz); defs.push({ label: 'z', color: COLOR_Z }); }
      if (ys.length) groups.push({ key: 'gyro', label: 'Gyroscope', unit: 'deg/s', ys, defs });
    }
    if (s.showOrientation) {
      // Orientation has its own canonical axis names — alpha/beta/gamma.
      // We still gate by the X/Y/Z toggle to keep the UX consistent.
      const ys: Float64Array[] = []; const defs: Array<{ label: string; color: string }> = [];
      if (s.axisX) { ys.push(ox); defs.push({ label: 'α', color: COLOR_X }); }
      if (s.axisY) { ys.push(oy); defs.push({ label: 'β', color: COLOR_Y }); }
      if (s.axisZ) { ys.push(oz); defs.push({ label: 'γ', color: COLOR_Z }); }
      if (ys.length) groups.push({ key: 'orient', label: 'Orientation', unit: 'deg', ys, defs });
    }
    return groups;
  });

  // Reactive effects: rebuild FFT / stats if relevant settings change
  $effect(() => {
    void $settings.motion.fftSize;
    void $settings.motion.fftWindow;
    void $settings.motion.fftOverlapPct;
    if (running) ensureFft();
  });
  $effect(() => {
    void $settings.motion.rmsWindowSec;
    void $settings.motion.meanWindowSec;
    void $settings.motion.peakHoldDecayDbPerSec;
    statsX = makeStats(); statsY = makeStats();
    statsZ = makeStats(); statsM = makeStats();
  });
</script>

<div class="page">
  <!-- Permission diagnostics, only shown when relevant -->
  {#if permission === 'denied'}
    <div class="banner danger" role="alert">
      Motion permission denied. iOS: Settings → Safari → Motion &amp; Orientation Access → On, then reload.
    </div>
  {/if}
  {#if permission === 'unsupported'}
    <div class="banner danger" role="alert">DeviceMotion is not supported in this browser.</div>
  {/if}

  <!-- Running indicator -->
  <div class="status-strip">
    <span class="dot" class:live={running}></span>
    <span class="subhead">
      {running ? 'Acquiring' : 'Idle'} · {hz} Hz · {count} samples
    </span>
  </div>

  <!-- KPI grid -->
  <p class="section-header">Magnitude · |a|</p>
  {#key tick}
  <section class="kpi-grid">
    <KpiCard label="Peak"   value={statsM.peak.peak}        unit="m/s²" onReset={() => statsM.peak.reset()}     big accent />
    <KpiCard label="RMS"    value={statsM.rms.rms}          unit="m/s²" onReset={() => statsM.rms.reset()} />
    <KpiCard label="Crest"  value={statsM.crestFactor}                  onReset={resetKpi} />
    <KpiCard label="Kurt"   value={statsM.kurt.kurtosis}                onReset={() => statsM.kurt.reset()} />
    <KpiCard label="Hold"   value={statsM.peakHold.hold}    unit="m/s²" onReset={() => statsM.peakHold.reset()} />
    <KpiCard label="Pk-Pk"  value={statsM.peak.peakToPeak}  unit="m/s²" onReset={() => statsM.peak.reset()} />
  </section>
  {/key}

  <!-- PER-AXIS KPIs (linear acceleration) — only the visible axes -->
  {#if $settings.motion.showLinear && ($settings.motion.axisX || $settings.motion.axisY || $settings.motion.axisZ)}
    <p class="section-header">Per-axis · linear acceleration</p>
    {#key tick}
    <section class="kpi-grid">
      {#if $settings.motion.axisX}
        <KpiCard label="X · Peak" value={statsX.peak.peak} unit="m/s²" onReset={() => statsX.peak.reset()} />
        <KpiCard label="X · RMS"  value={statsX.rms.rms}   unit="m/s²" onReset={() => statsX.rms.reset()} />
        <KpiCard label="X · Avg"  value={statsX.mean.mean} unit="m/s²" onReset={() => statsX.mean.reset()} />
      {/if}
      {#if $settings.motion.axisY}
        <KpiCard label="Y · Peak" value={statsY.peak.peak} unit="m/s²" onReset={() => statsY.peak.reset()} />
        <KpiCard label="Y · RMS"  value={statsY.rms.rms}   unit="m/s²" onReset={() => statsY.rms.reset()} />
        <KpiCard label="Y · Avg"  value={statsY.mean.mean} unit="m/s²" onReset={() => statsY.mean.reset()} />
      {/if}
      {#if $settings.motion.axisZ}
        <KpiCard label="Z · Peak" value={statsZ.peak.peak} unit="m/s²" onReset={() => statsZ.peak.reset()} />
        <KpiCard label="Z · RMS"  value={statsZ.rms.rms}   unit="m/s²" onReset={() => statsZ.rms.reset()} />
        <KpiCard label="Z · Avg"  value={statsZ.mean.mean} unit="m/s²" onReset={() => statsZ.mean.reset()} />
      {/if}
    </section>
    {/key}
  {/if}

  <!-- TIME DOMAIN — one chart per visible channel group -->
  {#if channelGroups.length > 0}
    <p class="section-header">Time domain</p>
    <div class="card chart-card" style="padding: 0; margin: 0 16px">
      <div class="card-head">
        <span class="headline">Window</span>
        <span class="spacer"></span>
        <select
          value={$settings.motion.timeWindowSec}
          onchange={(e) => updateMotion({ timeWindowSec: +(e.currentTarget as HTMLSelectElement).value })}
        >
          {#each [1, 5, 10, 30, 60] as w}
            <option value={w}>{w}s</option>
          {/each}
        </select>
      </div>
    </div>
    {#each channelGroups as g (g.key)}
      <section class="card chart-card group-card">
        <div class="card-head">
          <span class="headline">{g.label}</span>
          <span class="spacer"></span>
          <span class="caption-1">{g.unit}</span>
        </div>
        <div class="chart-host">
          <TimeChart
            {xs} ys={g.ys} seriesDefs={g.defs}
            {count}
            windowSec={$settings.motion.timeWindowSec}
            yLabel={g.unit}
          />
        </div>
      </section>
    {/each}
  {:else}
    <p class="section-header">Time domain</p>
    <section class="card chart-card">
      <div class="chart-host">
        <div class="placeholder">All channels are hidden — enable at least one in Settings → Motion → channels.</div>
      </div>
    </section>
  {/if}

  <!-- FFT -->
  <p class="section-header">Frequency domain · |a|</p>
  <section class="card chart-card">
    <div class="card-head">
      <span class="headline">Spectrum</span>
      <span class="spacer"></span>
      <select
        value={$settings.motion.fftSize}
        onchange={(e) => updateMotion({ fftSize: +(e.currentTarget as HTMLSelectElement).value as typeof FFT_SIZES[number] })}
      >
        {#each FFT_SIZES.filter(s => s <= 4096) as s}<option value={s}>{s}</option>{/each}
      </select>
      <select
        value={$settings.motion.fftWindow}
        onchange={(e) => updateMotion({ fftWindow: (e.currentTarget as HTMLSelectElement).value as typeof WINDOW_NAMES[number] })}
      >
        {#each WINDOW_NAMES as w}<option value={w}>{w}</option>{/each}
      </select>
    </div>
    <div class="chart-host">
      {#if fft}
        <FftChart
          freqs={fftFreqs}
          spectra={[$settings.motion.fftScaleLog ? fftDb : fftMag]}
          seriesDefs={[{ label: '|a|', color: COLOR_SPEC }]}
          logY={$settings.motion.fftScaleLog}
          logX={$settings.motion.fftFreqLog}
          autoScale={$settings.motion.fftAutoScale}
          yMin={$settings.motion.fftYMin}
          yMax={$settings.motion.fftYMax}
          yLabel={$settings.motion.fftScaleLog ? 'dB' : 'magnitude'}
        />
      {:else}
        <div class="placeholder">Tap Start to compute spectrum</div>
      {/if}
    </div>
  </section>

  <!-- DOMINANT FREQUENCIES -->
  <p class="section-header">Dominant frequencies · N = {$settings.motion.dominantFreqCount}</p>
  <section class="list-group" style="margin: 0 16px 16px">
    {#each dominant as d, i}
      <div class="list-row">
        <span class="dom-rank caption-1">#{i + 1}</span>
        <span class="list-row-label value-mono">{d.freq.toFixed(2)} <span class="footnote">Hz</span></span>
        <span class="footnote value-mono">{(20 * Math.log10(Math.max(d.mag, 1e-12))).toFixed(1)} dB</span>
      </div>
    {:else}
      <div class="list-row footnote">No signal yet</div>
    {/each}
  </section>

  <!-- 3D ORIENTATION CUBE (optional, toggled from Settings) -->
  {#if $settings.motion.showCube}
    <p class="section-header">3D orientation</p>
    <section class="card chart-card">
      <div class="cube-wrap">
        <OrientationCube
          alpha={orientation.alpha}
          beta={orientation.beta}
          gamma={orientation.gamma}
        />
      </div>
      <div class="list-row" style="border-top: 0.5px solid var(--separator)">
        <span class="caption-1" style="width: 56px; color: var(--fg-tertiary)">α / yaw</span>
        <span class="list-row-label value-mono">{orientation.alpha.toFixed(1)}<span class="footnote"> °</span></span>
      </div>
      <div class="list-row">
        <span class="caption-1" style="width: 56px; color: var(--fg-tertiary)">β / pitch</span>
        <span class="list-row-label value-mono">{orientation.beta.toFixed(1)}<span class="footnote"> °</span></span>
      </div>
      <div class="list-row">
        <span class="caption-1" style="width: 56px; color: var(--fg-tertiary)">γ / roll</span>
        <span class="list-row-label value-mono">{orientation.gamma.toFixed(1)}<span class="footnote"> °</span></span>
      </div>
    </section>
  {/if}
</div>

<FooterControls module="motion" {running} onStart={start} onStop={stop} onResetKpi={resetKpi} />

<style>
  .page {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0 12px;
    background: var(--bg-grouped);
  }
  .banner {
    margin: 8px 16px;
    padding: 12px 16px;
    background: var(--bg-elev);
    border-radius: var(--r-card);
    font-size: var(--t-footnote);
    color: var(--danger);
  }
  .status-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 12px;
  }
  .section-header {
    font-size: var(--t-footnote);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 16px 6px 20px;
    font-weight: 400;
  }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    padding: 0 16px;
  }
  @media (min-width: 480px) {
    .kpi-grid { grid-template-columns: repeat(3, 1fr); }
  }
  .chart-card {
    margin: 0 16px;
    overflow: hidden;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 0.5px solid var(--separator);
  }
  .card-head select { padding: 6px 28px 6px 10px; min-height: 32px; font-size: var(--t-subhead); }
  .chart-host {
    height: 220px;
    padding: 8px;
  }
  .placeholder {
    display: flex; align-items: center; justify-content: center;
    height: 100%;
    color: var(--fg-tertiary);
    font-size: var(--t-footnote);
  }
  .dom-rank {
    width: 36px;
    color: var(--fg-tertiary);
  }
  .cube-wrap {
    padding: 8px;
  }
  .group-card {
    margin: 0 16px 8px;
  }
  .group-card:last-of-type {
    margin-bottom: 16px;
  }
</style>
