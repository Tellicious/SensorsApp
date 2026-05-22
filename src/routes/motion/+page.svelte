<!--
  Motion module page.

  Bugs addressed in this revision:
  - "Spectrum says 'tap start to compute spectrum' even after starting":
    `fft` was a plain `let`, so the `{#if fft}` template branch never
    re-evaluated after `start()` assigned it. Now declared as
    `$state.raw` — reassignment is reactive (template re-runs), but
    mutations to the FftProcessor internals don't trigger work.
  - "RMS / Crest stop after ~1s", "Avg = 1000 m/s²", "Kurtosis just
    grows": all root-caused to the sliding-window bugs in dsp/kpi.ts,
    fixed there. This page only needed updated KPI-window settings.
  - "Organise KPIs by axis": KPIs are now grouped into four sections —
    |a| (magnitude), X, Y, Z — each rendering the same set of metrics
    gated by per-KPI visibility flags in settings.
  - "Select axes inline without going to settings": each chart card
    has an inline X / Y / Z pill row in its header that writes to
    settings.motion.axisX/Y/Z. Settings still owns the persistent flags;
    inline UI just exposes them where the user actually looks.
  - "Dominant frequencies keep changing rapidly": magnitudes are now
    exponentially smoothed before `dominantFrequencies()` is called,
    so the displayed list is damped (factor configurable in settings).
  - "When scrolling, data stops updating": iOS Safari throttles
    `setInterval` and RAF during scroll. The KPI snapshot is now also
    refreshed directly from the sensor callback (which fires from
    native events and isn't throttled the same way) with a 100 ms
    debounce, so values continue updating during scroll.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    settings,
    updateMotion
  } from '$lib/stores/settings';
  import { pushMotion } from '$lib/stores/session';
  import {
    createMotionController,
    requestMotionPermission,
    type MotionSample
  } from '$lib/sensors/motion';
  import { ChannelStats } from '$lib/dsp/kpi';
  import { FftProcessor, type FftSize } from '$lib/dsp/fft';
  import { dominantFrequencies } from '$lib/dsp/spectrum';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import TimeChart from '$lib/components/TimeChart.svelte';
  import FftChart from '$lib/components/FftChart.svelte';
  import FooterControls from '$lib/components/FooterControls.svelte';

  const ctrl = createMotionController();
  let running = $state(false);
  let permission = $state<'unknown' | 'granted' | 'denied' | 'unavailable'>('unknown');
  let hz = $state(0);

  // ---- Buffers --------------------------------------------------------
  const CAP = 4096;
  const xs = new Float64Array(CAP);
  const ax = new Float64Array(CAP), ay = new Float64Array(CAP), az = new Float64Array(CAP);
  const am = new Float64Array(CAP);
  const rx = new Float64Array(CAP), ry = new Float64Array(CAP), rz = new Float64Array(CAP);
  const gx = new Float64Array(CAP), gy = new Float64Array(CAP), gz = new Float64Array(CAP);
  const oa = new Float64Array(CAP), ob = new Float64Array(CAP), og = new Float64Array(CAP);
  let count = 0;
  let t0 = 0;
  let lastSampleT = 0;
  let lastSnapshotT = 0;

  // ---- Per-channel statistics -----------------------------------------
  // ChannelStats now accepts a `kurtosisCapacity` override so the
  // kurtosis window stays small (~4 s @ 60 Hz) while the FFT buffer
  // stays large. Without this, a startup transient kept kurtosis high
  // forever.
  function makeStats() {
    return new ChannelStats({
      capacity: CAP,
      rmsWindowSec:  $settings.motion.rmsWindowSec,
      meanWindowSec: $settings.motion.meanWindowSec,
      peakHoldDecayDbPerSec: $settings.motion.peakHoldDecayDbPerSec,
      kurtosisCapacity: 256
    });
  }
  let statsM = makeStats(), statsX = makeStats(), statsY = makeStats(), statsZ = makeStats();

  // ---- KPI snapshot ($state objects so the UI re-renders) -------------
  interface Kpi {
    peak: number; rms: number; mean: number;
    crest: number; kurt: number; hold: number; pkpk: number;
  }
  const zeroKpi = (): Kpi => ({ peak: 0, rms: 0, mean: 0, crest: 0, kurt: 0, hold: 0, pkpk: 0 });
  let kpiM = $state<Kpi>(zeroKpi());
  let kpiX = $state<Kpi>(zeroKpi());
  let kpiY = $state<Kpi>(zeroKpi());
  let kpiZ = $state<Kpi>(zeroKpi());

  function snapshot() {
    const snap = (s: ChannelStats): Kpi => ({
      peak:  s.peak.peak,
      rms:   s.rms.rms,
      mean:  s.mean.mean,
      crest: s.crestFactor,
      kurt:  s.kurt.kurtosis,
      hold:  s.peakHold.hold,
      pkpk:  s.peak.peakToPeak
    });
    kpiM = snap(statsM);
    kpiX = snap(statsX);
    kpiY = snap(statsY);
    kpiZ = snap(statsZ);
  }

  // ---- FFT (reactive flag fixes the "tap Start" placeholder) ----------
  // $state.raw: reassignment IS reactive (so `{#if fft}` flips after
  // `ensureFft()` builds the processor), but the deep proxy is skipped
  // so push/process mutations don't trigger Svelte invalidation each call.
  let fft = $state.raw<FftProcessor | null>(null);
  let fftMag = new Float32Array(1);
  let fftMagSmoothed = new Float32Array(1);
  let dominants = $state<{ freq: number; mag: number }[]>([]);

  function ensureFft() {
    const s = $settings.motion;
    const rate = Math.max(hz || 60, 1);
    if (!fft || fft.size !== s.fftSize || Math.abs(fft.sampleRate - rate) > 1) {
      fft = new FftProcessor({
        size: s.fftSize as FftSize,
        window: s.fftWindow,
        overlapPct: s.fftOverlapPct,
        sampleRate: rate
      });
      fftMag = new Float32Array(fft.bins);
      fftMagSmoothed = new Float32Array(fft.bins);
    }
  }

  function computeFft() {
    if (!fft) return;
    // Use magnitude channel for spectrum
    const src = am;
    const n = Math.min(count, fft.size);
    if (n < 8) return;
    const start = (count >= fft.size) ? count - fft.size : 0;
    const slice = src.subarray(start, start + n);
    // Zero-pad if buffer not yet full
    const buf = n === fft.size ? slice : (() => {
      const b = new Float64Array(fft!.size);
      b.set(slice);
      return b;
    })();
    fft.process(buf, fftMag);

    // Exponential moving average for damping
    const α = Math.max(0, Math.min(0.99, $settings.motion.dominantSmoothing));
    for (let i = 0; i < fftMag.length; i++) {
      fftMagSmoothed[i] = α * fftMagSmoothed[i] + (1 - α) * fftMag[i];
    }

    dominants = dominantFrequencies(
      fftMagSmoothed,
      fft.sampleRate,
      $settings.motion.dominantFreqCount
    );
  }

  // ---- Sensor callback -------------------------------------------------
  function onSample(s: MotionSample) {
    if (t0 === 0) t0 = s.t;
    const tSec = (s.t - t0) / 1000;
    const mag = Math.hypot(s.ax, s.ay, s.az);

    if (count < CAP) {
      xs[count] = tSec;
      ax[count] = s.ax; ay[count] = s.ay; az[count] = s.az; am[count] = mag;
      rx[count] = s.rx; ry[count] = s.ry; rz[count] = s.rz;
      gx[count] = s.gx; gy[count] = s.gy; gz[count] = s.gz;
      oa[count] = s.alpha ?? 0; ob[count] = s.beta ?? 0; og[count] = s.gamma ?? 0;
      count++;
    } else {
      // Slide all buffers left by 1
      xs.copyWithin(0, 1); ax.copyWithin(0, 1); ay.copyWithin(0, 1);
      az.copyWithin(0, 1); am.copyWithin(0, 1);
      rx.copyWithin(0, 1); ry.copyWithin(0, 1); rz.copyWithin(0, 1);
      gx.copyWithin(0, 1); gy.copyWithin(0, 1); gz.copyWithin(0, 1);
      oa.copyWithin(0, 1); ob.copyWithin(0, 1); og.copyWithin(0, 1);
      const i = CAP - 1;
      xs[i] = tSec;
      ax[i] = s.ax; ay[i] = s.ay; az[i] = s.az; am[i] = mag;
      rx[i] = s.rx; ry[i] = s.ry; rz[i] = s.rz;
      gx[i] = s.gx; gy[i] = s.gy; gz[i] = s.gz;
      oa[i] = s.alpha ?? 0; ob[i] = s.beta ?? 0; og[i] = s.gamma ?? 0;
    }

    statsM.push(mag,  s.t);
    statsX.push(s.ax, s.t);
    statsY.push(s.ay, s.t);
    statsZ.push(s.az, s.t);

    // Mitigates iOS scroll throttling: trigger a snapshot from inside
    // the native sensor event if the timer hasn't fired in 100 ms.
    if (s.t - lastSnapshotT > 100) {
      lastSnapshotT = s.t;
      snapshot();
    }
    lastSampleT = s.t;

    pushMotion({
      t: Math.floor(s.t - t0),
      ax: s.ax, ay: s.ay, az: s.az,
      rx: s.rx, ry: s.ry, rz: s.rz,
      gx: s.gx, gy: s.gy, gz: s.gz,
      mag,
      alpha: s.alpha, beta: s.beta, gamma: s.gamma
    });
  }

  // ---- Timers ----------------------------------------------------------
  let snapTimer = 0, fftTimer = 0, hzTimer = 0;
  let sampleCountAtHzCheck = 0;

  async function start() {
    if (running) return;
    permission = await requestMotionPermission();
    if (permission !== 'granted') return;
    statsM = makeStats(); statsX = makeStats(); statsY = makeStats(); statsZ = makeStats();
    count = 0; t0 = 0; lastSnapshotT = 0;
    ctrl.start(onSample);
    running = true;
    ensureFft();
    snapTimer = window.setInterval(snapshot, 100);
    fftTimer  = window.setInterval(computeFft, 200);
    sampleCountAtHzCheck = 0;
    hzTimer   = window.setInterval(() => {
      hz = (count - sampleCountAtHzCheck) / 0.5;
      sampleCountAtHzCheck = count;
      ensureFft();
    }, 500);
  }

  function stop() {
    ctrl.stop();
    running = false;
    if (snapTimer) { clearInterval(snapTimer); snapTimer = 0; }
    if (fftTimer)  { clearInterval(fftTimer);  fftTimer  = 0; }
    if (hzTimer)   { clearInterval(hzTimer);   hzTimer   = 0; }
  }
  onDestroy(stop);

  function resetKpi() {
    statsM.reset(); statsX.reset(); statsY.reset(); statsZ.reset();
    fftMagSmoothed.fill(0);
    snapshot();
  }

  // ---- UI helpers ------------------------------------------------------
  function fmt(v: number, digits = 2): string {
    if (!isFinite(v)) return '—';
    return v.toFixed(digits);
  }

  // Inline axis toggle pills — write straight back into settings so
  // the choice persists. Settings UI still controls per-KPI visibility.
  function toggleAxis(axis: 'X' | 'Y' | 'Z') {
    if (axis === 'X') updateMotion({ axisX: !$settings.motion.axisX });
    if (axis === 'Y') updateMotion({ axisY: !$settings.motion.axisY });
    if (axis === 'Z') updateMotion({ axisZ: !$settings.motion.axisZ });
  }

  // Build chart series list dynamically based on which axes are on
  const linYs = $derived.by(() => {
    void count; // re-run on every sample push
    const list: Float64Array[] = [];
    if ($settings.motion.axisX) list.push(ax);
    if ($settings.motion.axisY) list.push(ay);
    if ($settings.motion.axisZ) list.push(az);
    return list;
  });
  const linSeries = $derived.by(() => {
    const list: { label: string; color: string }[] = [];
    if ($settings.motion.axisX) list.push({ label: 'X', color: 'var(--series-1)' });
    if ($settings.motion.axisY) list.push({ label: 'Y', color: 'var(--series-2)' });
    if ($settings.motion.axisZ) list.push({ label: 'Z', color: 'var(--series-3)' });
    return list;
  });
</script>

<div class="page">
  <div class="status-strip">
    <span class="dot" class:live={running}></span>
    <span class="subhead">
      {running ? 'Sampling' : 'Idle'}
      · {hz.toFixed(0)} Hz · {count} samples
    </span>
  </div>

  {#if permission === 'denied'}
    <div class="banner danger">Motion permission denied. Enable in Safari → Privacy.</div>
  {:else if permission === 'unavailable'}
    <div class="banner">DeviceMotion not available on this device / browser.</div>
  {/if}

  <!-- ========= MAGNITUDE ========= -->
  {#if $settings.motion.showMagnitude}
    <p class="section-header">|a| · magnitude</p>
    <section class="kpi-grid">
      {#if $settings.motion.kpiVisible.peak}
        <KpiCard label="Peak" value={fmt(kpiM.peak)} unit="m/s²" onReset={resetKpi} big accent />
      {/if}
      {#if $settings.motion.kpiVisible.rms}
        <KpiCard label="RMS" value={fmt(kpiM.rms)} unit="m/s²" onReset={resetKpi} />
      {/if}
      {#if $settings.motion.kpiVisible.crest}
        <KpiCard label="Crest" value={fmt(kpiM.crest)} onReset={resetKpi} />
      {/if}
      {#if $settings.motion.kpiVisible.kurt}
        <KpiCard label="Kurt" value={fmt(kpiM.kurt)} onReset={resetKpi} />
      {/if}
      {#if $settings.motion.kpiVisible.hold}
        <KpiCard label="Hold" value={fmt(kpiM.hold)} unit="m/s²" onReset={resetKpi} />
      {/if}
      {#if $settings.motion.kpiVisible.pkpk}
        <KpiCard label="Pk-Pk" value={fmt(kpiM.pkpk)} unit="m/s²" onReset={resetKpi} />
      {/if}
    </section>
  {/if}

  <!-- ========= X AXIS ========= -->
  <p class="section-header">X · linear acceleration</p>
  <section class="kpi-grid">
    {#if $settings.motion.kpiVisible.peak}
      <KpiCard label="X Peak" value={fmt(kpiX.peak)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.rms}
      <KpiCard label="X RMS" value={fmt(kpiX.rms)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.avg}
      <KpiCard label="X Avg" value={fmt(kpiX.mean)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.crest}
      <KpiCard label="X Crest" value={fmt(kpiX.crest)} onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.kurt}
      <KpiCard label="X Kurt" value={fmt(kpiX.kurt)} onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.hold}
      <KpiCard label="X Hold" value={fmt(kpiX.hold)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.pkpk}
      <KpiCard label="X Pk-Pk" value={fmt(kpiX.pkpk)} unit="m/s²" onReset={resetKpi} />
    {/if}
  </section>

  <!-- ========= Y AXIS ========= -->
  <p class="section-header">Y · linear acceleration</p>
  <section class="kpi-grid">
    {#if $settings.motion.kpiVisible.peak}
      <KpiCard label="Y Peak" value={fmt(kpiY.peak)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.rms}
      <KpiCard label="Y RMS" value={fmt(kpiY.rms)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.avg}
      <KpiCard label="Y Avg" value={fmt(kpiY.mean)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.crest}
      <KpiCard label="Y Crest" value={fmt(kpiY.crest)} onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.kurt}
      <KpiCard label="Y Kurt" value={fmt(kpiY.kurt)} onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.hold}
      <KpiCard label="Y Hold" value={fmt(kpiY.hold)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.pkpk}
      <KpiCard label="Y Pk-Pk" value={fmt(kpiY.pkpk)} unit="m/s²" onReset={resetKpi} />
    {/if}
  </section>

  <!-- ========= Z AXIS ========= -->
  <p class="section-header">Z · linear acceleration</p>
  <section class="kpi-grid">
    {#if $settings.motion.kpiVisible.peak}
      <KpiCard label="Z Peak" value={fmt(kpiZ.peak)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.rms}
      <KpiCard label="Z RMS" value={fmt(kpiZ.rms)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.avg}
      <KpiCard label="Z Avg" value={fmt(kpiZ.mean)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.crest}
      <KpiCard label="Z Crest" value={fmt(kpiZ.crest)} onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.kurt}
      <KpiCard label="Z Kurt" value={fmt(kpiZ.kurt)} onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.hold}
      <KpiCard label="Z Hold" value={fmt(kpiZ.hold)} unit="m/s²" onReset={resetKpi} />
    {/if}
    {#if $settings.motion.kpiVisible.pkpk}
      <KpiCard label="Z Pk-Pk" value={fmt(kpiZ.pkpk)} unit="m/s²" onReset={resetKpi} />
    {/if}
  </section>

  <!-- ========= LINEAR-ACCEL CHART (with inline axis toggle pills) ========= -->
  {#if $settings.motion.showLinear}
    <p class="section-header">Linear acceleration</p>
    <section class="card chart-card">
      <div class="card-head">
        <span class="headline">a(t)</span>
        <span class="spacer"></span>
        <div class="axis-pills">
          <button class="axis-pill" class:on={$settings.motion.axisX} onclick={() => toggleAxis('X')}>X</button>
          <button class="axis-pill" class:on={$settings.motion.axisY} onclick={() => toggleAxis('Y')}>Y</button>
          <button class="axis-pill" class:on={$settings.motion.axisZ} onclick={() => toggleAxis('Z')}>Z</button>
        </div>
      </div>
      <div class="chart-host">
        {#if linYs.length > 0}
          {#key linSeries.length}
            <TimeChart
              {xs} ys={linYs} seriesDefs={linSeries}
              {count} windowSec={$settings.motion.timeWindowSec}
              yLabel="m/s²"
              fullscreenTitle="Linear acceleration"
            />
          {/key}
        {:else}
          <div class="placeholder">All axes hidden — toggle X / Y / Z above</div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- ========= MAGNITUDE CHART ========= -->
  {#if $settings.motion.showMagnitude}
    <p class="section-header">Magnitude</p>
    <section class="card chart-card">
      <div class="card-head"><span class="headline">|a|(t)</span></div>
      <div class="chart-host">
        <TimeChart
          {xs} ys={[am]}
          seriesDefs={[{ label: '|a|', color: 'var(--series-4)' }]}
          {count} windowSec={$settings.motion.timeWindowSec}
          yLabel="m/s²"
          fullscreenTitle="Magnitude"
        />
      </div>
    </section>
  {/if}

  <!-- ========= GYRO ========= -->
  {#if $settings.motion.showGyro}
    <p class="section-header">Gyroscope (rad/s)</p>
    <section class="card chart-card">
      <div class="card-head"><span class="headline">ω(t)</span></div>
      <div class="chart-host">
        <TimeChart
          {xs} ys={[gx, gy, gz]}
          seriesDefs={[
            { label: 'gx', color: 'var(--series-1)' },
            { label: 'gy', color: 'var(--series-2)' },
            { label: 'gz', color: 'var(--series-3)' }
          ]}
          {count} windowSec={$settings.motion.timeWindowSec}
          yLabel="rad/s"
          fullscreenTitle="Gyroscope"
        />
      </div>
    </section>
  {/if}

  <!-- ========= SPECTRUM ========= -->
  <p class="section-header">Spectrum · |a|</p>
  <section class="card chart-card">
    <div class="card-head">
      <span class="headline">FFT</span>
      <span class="spacer"></span>
      {#if dominants.length > 0}
        <span class="footnote">Top: {dominants.slice(0, 3).map(d => `${d.freq.toFixed(1)} Hz`).join(' · ')}</span>
      {/if}
    </div>
    <div class="chart-host">
      {#if fft}
        <FftChart
          freqs={fft.frequencies}
          spectra={[fftMagSmoothed]}
          seriesDefs={[{ label: '|a|', color: 'var(--series-4)' }]}
          logX={$settings.motion.fftFreqLog}
          logY={$settings.motion.fftScaleLog}
          autoScale={$settings.motion.fftAutoScale}
          yMin={$settings.motion.fftYMin}
          yMax={$settings.motion.fftYMax}
          fullscreenTitle="Spectrum |a|"
        />
      {:else}
        <div class="placeholder">Tap Start to compute spectrum</div>
      {/if}
    </div>
    {#if dominants.length > 0}
      <div class="dominants-list">
        {#each dominants as d, i}
          <span class="dom-pill">{i + 1}. {d.freq.toFixed(2)} Hz</span>
        {/each}
      </div>
    {/if}
  </section>
</div>

<FooterControls module="motion" {running} onStart={start} onStop={stop} onResetKpi={resetKpi} />

<style>
  .page {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0 12px;
    background: var(--bg-grouped);
    -webkit-overflow-scrolling: touch;
  }
  .status-strip { display: flex; align-items: center; gap: 8px; padding: 0 16px 12px; }
  .banner {
    margin: 8px 16px;
    padding: 12px 16px;
    background: var(--bg-elev);
    border-radius: var(--r-card);
    font-size: var(--t-footnote);
  }
  .banner.danger { color: var(--danger); }
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
  .chart-card { margin: 0 16px; overflow: hidden; }
  .card-head {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px;
    border-bottom: 0.5px solid var(--separator);
    min-height: 44px;
  }
  .spacer { flex: 1; }
  .chart-host { padding: 8px; height: 200px; }
  .placeholder {
    display: flex; align-items: center; justify-content: center;
    height: 100%;
    color: var(--fg-tertiary);
    font-size: var(--t-footnote);
    text-align: center;
    padding: 0 16px;
  }
  .dominants-list {
    display: flex; flex-wrap: wrap; gap: 6px;
    padding: 8px 14px 12px;
    border-top: 0.5px solid var(--separator);
  }
  .dom-pill {
    font-size: var(--t-footnote);
    font-family: var(--mono);
    background: var(--fill-tertiary);
    padding: 4px 8px;
    border-radius: var(--r-pill);
    color: var(--fg-secondary);
  }
  .axis-pills { display: flex; gap: 4px; }
  .axis-pill {
    min-width: 28px; min-height: 28px;
    padding: 4px 10px;
    background: var(--fill-tertiary);
    color: var(--fg-secondary);
    border: none;
    border-radius: var(--r-pill);
    font-size: var(--t-footnote);
    font-weight: 600;
    cursor: pointer;
  }
  .axis-pill.on { background: var(--tint); color: #fff; }
  .axis-pill:active { opacity: 0.7; }
</style>
