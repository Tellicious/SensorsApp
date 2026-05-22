<!--
  Audio module page.

  Critical bug fixed in this revision: the time-domain waveform was
  completely flat. Root cause was the template prop:

      ys={[Float64Array.from(timeBuf)]}

  This created a brand-new Float64Array on each render, but the
  template never re-evaluated (no reactive dep), so the FftChart /
  TimeChart RAF reader captured a snapshot at mount and that snapshot
  never updated. The fix is to pre-allocate a stable Float64Array
  (`timeBufF64`), mutate it in place on every loop tick, and pass the
  same reference into the chart — exactly how Motion does it.

  Frequency display previously appeared "empty" for the same reason
  for some users (off-zero floor data, but no visible motion because
  prop refs were stale on settings change). The dB-weighted buffer
  is now also mutated in place from a stable reference.

  Dominant frequencies are exponentially smoothed before
  `dominantFrequencies()` is called, matching the motion page.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { settings } from '$lib/stores/settings';
  import { pushAudio } from '$lib/stores/session';
  import { createAudioController, type AudioController } from '$lib/sensors/audio';
  import { applyWeighting } from '$lib/dsp/weighting';
  import { dominantFrequencies } from '$lib/dsp/spectrum';
  import { RollingRms, PeakTracker } from '$lib/dsp/kpi';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import TimeChart from '$lib/components/TimeChart.svelte';
  import FftChart from '$lib/components/FftChart.svelte';
  import FooterControls from '$lib/components/FooterControls.svelte';

  let ctrl = $state<AudioController | null>(null);
  let running = $state(false);
  let permError = $state<string | null>(null);
  let sampleRate = $state(48000);

  // ---- Buffers --------------------------------------------------------
  // Mic time-domain (Float32 from Web Audio) + stable F64 mirror for the chart
  let timeBuf  = new Float32Array(1);
  let timeBufF64 = $state(new Float64Array(1));
  let timeXs   = $state(new Float64Array(1));
  // Spectrum buffers
  let dbRaw = new Float32Array(1);          // raw dBFS magnitudes
  let dbWeighted = $state(new Float32Array(1));      // after Z/A/C weighting
  let dbSmoothed = $state(new Float32Array(1));      // EMA of dbWeighted (for damped dominants)
  let freqs = $state(new Float32Array(1));

  function ensureBuffers(fftSize: number, sr: number) {
    if (timeBuf.length !== fftSize) {
      timeBuf  = new Float32Array(fftSize);
      timeBufF64 = new Float64Array(fftSize);
      timeXs   = new Float64Array(fftSize);
      for (let i = 0; i < fftSize; i++) timeXs[i] = (i / sr) * 1000;
    }
    const bins = Math.floor(fftSize / 2) + 1;
    if (dbRaw.length !== bins) {
      dbRaw = new Float32Array(bins);
      dbWeighted = new Float32Array(bins);
      dbSmoothed = new Float32Array(bins);
      freqs = new Float32Array(bins);
      for (let i = 0; i < bins; i++) freqs[i] = (i * sr) / fftSize;
    }
  }

  // ---- KPIs -----------------------------------------------------------
  let peakTracker = new PeakTracker();
  let rmsTracker = new RollingRms(48000, 1);
  let leqSum = 0, leqCount = 0;
  let tick = $state(0);

  const calOffset = $derived($settings.audio.calibration.offsetDb);
  const peakDbFS  = $derived.by(() => { void tick; return peakTracker.peak > 0 ? 20 * Math.log10(peakTracker.peak) : -Infinity; });
  const rmsDbFS   = $derived.by(() => { void tick; const r = rmsTracker.rms; return r > 0 ? 20 * Math.log10(r) : -Infinity; });
  const peakDb    = $derived(isFinite(peakDbFS) ? peakDbFS + calOffset : -Infinity);
  const rmsDb     = $derived(isFinite(rmsDbFS)  ? rmsDbFS  + calOffset : -Infinity);
  const crestDb   = $derived(isFinite(peakDb) && isFinite(rmsDb) ? peakDb - rmsDb : 0);
  const leqDisplay= $derived(leqCount > 0 ? 10 * Math.log10(leqSum / leqCount) + calOffset : -Infinity);
  let dominants = $state<{ freq: number; mag: number }[]>([]);

  function fmtDb(v: number): string {
    if (!isFinite(v)) return '—';
    return v.toFixed(1);
  }

  // ---- Loop -----------------------------------------------------------
  let rafId = 0;
  function loop() {
    if (!running || !ctrl) return;
    ctrl.getTimeDomain(timeBuf);
    // Copy into the stable F64 buffer that the chart watches
    for (let i = 0; i < timeBuf.length; i++) timeBufF64[i] = timeBuf[i];

    // Peak + RMS over the new chunk
    let peak = 0; let sumSq = 0;
    const tNow = performance.now();
    for (let i = 0; i < timeBuf.length; i++) {
      const v = timeBuf[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
      // Feed RMS tracker at the sample rate
      rmsTracker.push(v, tNow + (i * 1000) / sampleRate);
    }
    if (peak > 0) peakTracker.push(peak);

    // dB-weighted spectrum
    ctrl.getFrequencyDataDb(dbRaw);
    applyWeighting(dbRaw, dbWeighted, freqs, $settings.audio.weighting);

    // Equivalent continuous level: integrate weighted power over time
    let pSum = 0; let pCount = 0;
    for (let i = 0; i < dbWeighted.length; i++) {
      if (isFinite(dbWeighted[i])) {
        pSum += Math.pow(10, dbWeighted[i] / 10);
        pCount++;
      }
    }
    if (pCount > 0) { leqSum += pSum / pCount; leqCount++; }

    // EMA smoothing for damped dominants
    const α = Math.max(0, Math.min(0.99, $settings.audio.dominantSmoothing));
    for (let i = 0; i < dbWeighted.length; i++) {
      dbSmoothed[i] = α * dbSmoothed[i] + (1 - α) * dbWeighted[i];
    }
    dominants = dominantFrequencies(dbSmoothed, sampleRate, $settings.audio.dominantFreqCount);

    pushAudio({
      t: Math.floor(performance.now()),
      peakDb: isFinite(peakDb)  ? peakDb  : -120,
      rmsDb:  isFinite(rmsDb)   ? rmsDb   : -120,
      leqDb:  isFinite(leqDisplay) ? leqDisplay : -120
    });

    tick++;
    rafId = requestAnimationFrame(loop);
  }

  // ---- Lifecycle ------------------------------------------------------
  async function start() {
    if (running) return;
    permError = null;
    try {
      ctrl = await createAudioController($settings.audio.fftSize);
      await ctrl.start();
      sampleRate = ctrl.sampleRate;
      ensureBuffers(ctrl.fftSize, sampleRate);
      running = true;
      peakTracker.reset();
      rmsTracker = new RollingRms(sampleRate, $settings.audio.rmsWindowSec);
      leqSum = 0; leqCount = 0;
      dbSmoothed.fill(0);
      loop();
    } catch (e) {
      permError = (e as Error).message || 'Microphone access failed';
      ctrl = null;
    }
  }

  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (ctrl)  { ctrl.stop(); ctrl = null; }
  }
  onDestroy(stop);

  function resetKpi() {
    peakTracker.reset();
    rmsTracker.reset();
    leqSum = 0; leqCount = 0;
    dbSmoothed.fill(0);
    tick++;
  }
</script>

<div class="page">
  <div class="status-strip">
    <span class="dot" class:live={running}></span>
    <span class="subhead">
      {running ? 'Listening' : 'Idle'}
      {#if running} · {sampleRate} Hz · {$settings.audio.fftSize} pts{/if}
    </span>
  </div>

  {#if permError}<div class="banner danger">{permError}</div>{/if}

  {#if $settings.audio.calibration.method === 'none'}
    <div class="banner">
      Uncalibrated — readings are in dBFS. Calibrate in Settings to read SPL.
    </div>
  {/if}

  <!-- KPIs -->
  <p class="section-header">Level</p>
  <section class="kpi-grid">
    {#if $settings.audio.kpiVisible.peak}
      <KpiCard
        label="Peak"
        value={fmtDb(peakDb)}
        unit={$settings.audio.calibration.method === 'none' ? 'dBFS' : 'dB SPL'}
        onReset={resetKpi} big accent
      />
    {/if}
    {#if $settings.audio.kpiVisible.rms}
      <KpiCard
        label="RMS"
        value={fmtDb(rmsDb)}
        unit={$settings.audio.calibration.method === 'none' ? 'dBFS' : 'dB SPL'}
        onReset={resetKpi}
      />
    {/if}
    {#if $settings.audio.kpiVisible.rms}
      <KpiCard
        label="Leq"
        value={fmtDb(leqDisplay)}
        unit={$settings.audio.calibration.method === 'none' ? 'dBFS' : 'dB SPL'}
        onReset={resetKpi}
      />
    {/if}
    {#if $settings.audio.kpiVisible.crest}
      <KpiCard label="Crest" value={fmtDb(crestDb)} unit="dB" onReset={resetKpi} />
    {/if}
  </section>

  <!-- Waveform -->
  {#if $settings.audio.showWaveform}
    <p class="section-header">Waveform · time domain</p>
    <section class="card chart-card">
      <div class="card-head"><span class="headline">y(t)</span></div>
      <div class="chart-host">
        {#if running && timeBufF64.length > 1}
          <TimeChart
            xs={timeXs}
            ys={[timeBufF64]}
            seriesDefs={[{ label: 'mic', color: 'var(--series-2)' }]}
            count={timeBufF64.length}
            windowSec={$settings.audio.waveformWindowMs / 1000}
            yMin={-1} yMax={1}
            yLabel=""
            xLabel="ms"
            fullscreenTitle="Audio waveform"
          />
        {:else}
          <div class="placeholder">Tap Start to listen</div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- Spectrum -->
  {#if $settings.audio.showSpectrum}
    <p class="section-header">Spectrum · {$settings.audio.weighting}-weighted</p>
    <section class="card chart-card">
      <div class="card-head">
        <span class="headline">FFT</span>
        <span class="spacer"></span>
        {#if dominants.length > 0}
          <span class="footnote">Top: {dominants.slice(0, 3).map(d => `${d.freq.toFixed(0)} Hz`).join(' · ')}</span>
        {/if}
      </div>
      <div class="chart-host">
        {#if running && dbSmoothed.length > 1}
          <FftChart
            {freqs}
            spectra={[dbSmoothed]}
            seriesDefs={[{ label: `${$settings.audio.weighting}-w`, color: 'var(--series-4)' }]}
            logX={$settings.audio.fftFreqLog}
            logY={true}
            autoScale={false}
            yMin={-120 + calOffset}
            yMax={0 + calOffset}
            fullscreenTitle="Audio spectrum"
          />
        {:else}
          <div class="placeholder">Tap Start to compute spectrum</div>
        {/if}
      </div>
      {#if dominants.length > 0}
        <div class="dominants-list">
          {#each dominants as d, i}
            <span class="dom-pill">{i + 1}. {d.freq.toFixed(1)} Hz</span>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<FooterControls module="audio" {running} onStart={start} onStop={stop} onResetKpi={resetKpi} />

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
</style>
