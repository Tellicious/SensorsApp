<!--
  Audio module page.

  Provides live mic visualization with no logging (by design):
  - Waveform (Float32 time-domain block from AnalyserNode)
  - Spectrum (FFT magnitude in dB, weighted Z/A/C per settings)
  - Calibration strip showing current method, offset, and a Re-calibrate button
  - KPIs: Peak, RMS, Leq — all in dBFS or dB SPL depending on calibration state
  - Dominant frequencies list

  Why no logging: long-form audio capture (raw samples or downsampled
  spectrum) at 48 kHz is several MB/minute and quickly hits iOS IndexedDB
  quota. Audio readings here are live-only.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { settings, updateAudio } from '$lib/stores/settings';
  import { createAudioController, type AudioController } from '$lib/sensors/audio';
  import { FFT_SIZES } from '$lib/dsp/fft';
  import { WINDOW_NAMES } from '$lib/dsp/windowing';
  import { weightingOffsets, weightedBroadbandDb, applyWeightingDb } from '$lib/dsp/weighting';
  import { dominantFrequencies } from '$lib/dsp/fft';
  import { PeakTracker, RollingRms } from '$lib/dsp/kpi';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import TimeChart from '$lib/components/TimeChart.svelte';
  import FftChart from '$lib/components/FftChart.svelte';
  import FooterControls from '$lib/components/FooterControls.svelte';
  import CalibrationWizard from '$lib/components/CalibrationWizard.svelte';
  import SpectrogramChart from '$lib/components/SpectrogramChart.svelte';

  let ctrl: AudioController | null = null;
  let running = $state(false);
  let sampleRate = $state(0);
  let bins = $state(0);

  let freqs = $state(new Float32Array(1));
  let timeBuf = $state(new Float32Array(1));
  let timeXs = $state(new Float64Array(1));
  let mag = $state(new Float32Array(1));
  let db = $state(new Float32Array(1));
  let dbWeighted = $state(new Float32Array(1));
  let weightOff = $state(new Float32Array(1));

  let dominant = $state<Array<{ freq: number; mag: number }>>([]);
  // Plain class instances (not $state) — re-render via the `tick` counter
  let peakTracker = new PeakTracker();
  let rmsTracker = new RollingRms(48000, 1);
  // Running Leq accumulator. Stored as linear power sum + count so that
  // each new frame just adds and re-divides — true equivalent level.
  let leqSum = 0, leqCount = 0;
  let leqDbfs = $state(-200);

  let showWizard = $state(false);
  let tick = $state(0);
  let rafId = 0;

  /**
   * (Re)allocate every buffer that depends on fftSize and sampleRate.
   * Called on Start and whenever fftSize changes mid-stream.
   */
  function ensureBuffers(size: number, rate: number) {
    bins = size / 2;
    freqs = new Float32Array(bins);
    for (let k = 0; k < bins; k++) freqs[k] = (k * rate) / size;
    timeBuf = new Float32Array(size);
    timeXs = new Float64Array(size);
    for (let i = 0; i < size; i++) timeXs[i] = (i / rate);
    mag = new Float32Array(bins);
    db = new Float32Array(bins);
    dbWeighted = new Float32Array(bins);
    weightOff = weightingOffsets(freqs, $settings.audio.weighting);
  }

  /**
   * Start mic acquisition. Triggers the iOS permission prompt the first
   * time. Must be called from a user-gesture handler.
   */
  async function start() {
    if (running) return;
    ctrl = await createAudioController($settings.audio.fftSize);
    await ctrl.start();
    sampleRate = ctrl.sampleRate;
    ensureBuffers(ctrl.fftSize, sampleRate);
    running = true;
    peakTracker.reset();
    rmsTracker = new RollingRms(sampleRate, $settings.audio.rmsWindowSec);
    leqSum = 0; leqCount = 0;
    loop();
  }

  async function stop() {
    running = false;
    cancelAnimationFrame(rafId);
    if (ctrl) { await ctrl.stop(); ctrl = null; }
  }

  /**
   * Main render loop: every RAF tick, pull time and frequency data from
   * the AnalyserNode, update KPIs, integrate Leq, find dominants. Throttled
   * to RAF; uPlot charts have their own ~30 fps cap internally.
   */
  function loop() {
    if (!running || !ctrl) return;
    ctrl.getTimeDomain(timeBuf);
    ctrl.getFrequencyMag(mag);
    // mag → dB
    for (let k = 0; k < bins; k++) db[k] = mag[k] > 1e-12 ? 20 * Math.log10(mag[k]) : -200;
    applyWeightingDb(db, weightOff, dbWeighted);
    // Per-block peak and RMS
    let p = 0, sumSq = 0;
    for (let i = 0; i < timeBuf.length; i++) {
      const v = timeBuf[i];
      if (Math.abs(v) > p) p = Math.abs(v);
      sumSq += v * v;
    }
    peakTracker.push(p);
    const tNow = performance.now();
    rmsTracker.push(Math.sqrt(sumSq / timeBuf.length), tNow);
    // Leq accumulation
    const bbDb = weightedBroadbandDb(mag, weightOff);
    if (isFinite(bbDb)) {
      leqSum += Math.pow(10, bbDb / 10);
      leqCount++;
      leqDbfs = 10 * Math.log10(leqSum / leqCount);
    }
    dominant = dominantFrequencies(mag, freqs, $settings.audio.dominantFreqCount, 2);
    tick++;
    rafId = requestAnimationFrame(loop);
  }

  function resetKpi() {
    peakTracker.reset();
    rmsTracker.reset();
    leqSum = 0; leqCount = 0; leqDbfs = -200;
  }

  $effect(() => {
    void $settings.audio.weighting;
    if (freqs.length > 1) weightOff = weightingOffsets(freqs, $settings.audio.weighting);
  });
  $effect(() => {
    if (ctrl && ctrl.fftSize !== $settings.audio.fftSize) {
      ctrl.setFftSize($settings.audio.fftSize);
      ensureBuffers($settings.audio.fftSize, sampleRate);
    }
  });
  onDestroy(stop);

  // ---- Derived display values (with calibration) ----------------------
  const calOffset = $derived($settings.audio.calibration.offsetDb);
  /** Pick the right unit label based on calibration state + weighting. */
  const dbUnit = $derived(
    $settings.audio.calibration.method === 'none' ? 'dBFS' :
    $settings.audio.weighting === 'A' ? 'dB(A)' :
    $settings.audio.weighting === 'C' ? 'dB(C)' : 'dB SPL'
  );
  // Force re-eval when tick changes — peakTracker/rmsTracker aren't reactive
  const peakDb = $derived.by(() => {
    void tick;
    return peakTracker.peak > 0 ? 20 * Math.log10(peakTracker.peak) + calOffset : -200;
  });
  const rmsDb = $derived.by(() => {
    void tick;
    return rmsTracker.rms > 0 ? 20 * Math.log10(rmsTracker.rms) + calOffset : -200;
  });
  /**
   * Crest factor in dB: peak/RMS expressed in decibels.
   * Pure-tone sine: 3 dB · sawtooth: ~5 dB · pink noise: ~12 dB ·
   * music: 12–20 dB · transients (snare): up to ~30 dB.
   * Useful as a quick proxy for how transient-rich the signal is.
   */
  const crestDb = $derived.by(() => {
    void tick;
    if (rmsTracker.rms <= 0 || peakTracker.peak <= 0) return 0;
    return 20 * Math.log10(peakTracker.peak / rmsTracker.rms);
  });

  function applyCal(v: number) { return isFinite(v) ? v + calOffset : v; }
</script>

<div class="page">
  <div class="status-strip">
    <span class="dot" class:live={running}></span>
    <span class="subhead">
      {running ? 'Acquiring' : 'Idle'}
      {#if sampleRate > 0} · {sampleRate} Hz{/if}
      · {$settings.audio.weighting}-weighted
    </span>
  </div>

  <!-- Calibration strip — surfaces current state + Re-cal action -->
  <section class="card calib-strip">
    <div class="grow">
      <div class="footnote">Reference</div>
      <div class="headline">{dbUnit}</div>
      {#if $settings.audio.calibration.calibratedAt}
        <div class="caption-1">
          +{calOffset.toFixed(1)} dB · method {$settings.audio.calibration.method[0].toUpperCase()} ·
          {new Date($settings.audio.calibration.calibratedAt).toLocaleDateString()}
        </div>
      {:else}
        <div class="caption-1">Uncalibrated — readings in dBFS</div>
      {/if}
    </div>
    <button class="btn-tinted btn-small" onclick={() => showWizard = true}>
      {$settings.audio.calibration.method === 'none' ? 'Calibrate' : 'Re-cal'}
    </button>
  </section>

  <!-- KPI grid -->
  <p class="section-header">Levels</p>
  {#key tick}
  <section class="kpi-grid">
    <KpiCard label="Peak"  value={peakDb} unit={dbUnit} big accent onReset={() => peakTracker.reset()} />
    <KpiCard label="RMS"   value={rmsDb}  unit={dbUnit} onReset={() => rmsTracker.reset()} />
    <KpiCard label="Leq"   value={leqDbfs + calOffset} unit={dbUnit} onReset={resetKpi} />
    <KpiCard label="Crest" value={crestDb} unit="dB" onReset={resetKpi} />
  </section>
  {/key}

  <!-- WAVEFORM (optional, toggled in Settings → Audio → display) -->
  {#if $settings.audio.showWaveform}
    <p class="section-header">Waveform</p>
    <section class="card chart-card">
      <div class="card-head">
        <span class="headline">Time domain</span>
        <span class="spacer"></span>
        <select
          value={$settings.audio.waveformWindowMs}
          onchange={(e) => updateAudio({ waveformWindowMs: +(e.currentTarget as HTMLSelectElement).value as 50 | 100 | 500 | 1000 })}
        >
          {#each [50, 100, 500, 1000] as w}<option value={w}>{w}ms</option>{/each}
        </select>
      </div>
      <div class="chart-host" style="height: 160px">
        {#if running}
          <TimeChart
            xs={timeXs}
            ys={[Float64Array.from(timeBuf)]}
            seriesDefs={[{ label: 'audio', color: 'var(--series-2)' }]}
            count={timeBuf.length}
            windowSec={$settings.audio.waveformWindowMs / 1000}
            yLabel="amplitude"
          />
        {:else}
          <div class="placeholder">Tap Start to acquire audio</div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- SPECTRUM (optional) -->
  {#if $settings.audio.showSpectrum}
    <p class="section-header">Spectrum</p>
    <section class="card chart-card">
      <div class="card-head">
        <span class="headline">Frequency · {dbUnit}</span>
        <span class="spacer"></span>
        <select
          value={$settings.audio.weighting}
          onchange={(e) => updateAudio({ weighting: (e.currentTarget as HTMLSelectElement).value as 'A' | 'C' | 'Z' })}
        >
          <option value="Z">Z</option>
          <option value="A">A</option>
          <option value="C">C</option>
        </select>
        <select
          value={$settings.audio.fftSize}
          onchange={(e) => updateAudio({ fftSize: +(e.currentTarget as HTMLSelectElement).value as typeof FFT_SIZES[number] })}
        >
          {#each FFT_SIZES as s}<option value={s}>{s}</option>{/each}
        </select>
        <select
          value={$settings.audio.fftWindow}
          onchange={(e) => updateAudio({ fftWindow: (e.currentTarget as HTMLSelectElement).value as typeof WINDOW_NAMES[number] })}
        >
          {#each WINDOW_NAMES as w}<option value={w}>{w}</option>{/each}
        </select>
      </div>
      <div class="chart-host" style="height: 240px">
        {#if running}
          <FftChart
            {freqs}
            spectra={[dbWeighted]}
            seriesDefs={[{ label: 'audio', color: 'var(--tint)' }]}
            logY={true}
            logX={$settings.audio.fftFreqLog}
            autoScale={false}
            yMin={-120 + calOffset}
            yMax={0 + calOffset}
            yLabel={dbUnit}
          />
        {:else}
          <div class="placeholder">Tap Start to compute spectrum</div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- SPECTROGRAM (optional, scrolling waterfall) -->
  {#if $settings.audio.showSpectrogram}
    <p class="section-header">Spectrogram</p>
    <section class="card chart-card">
      <div class="card-head">
        <span class="headline">Waterfall · viridis</span>
        <span class="spacer"></span>
        <span class="caption-1">log freq · −120 → 0 dB</span>
      </div>
      <div class="chart-host" style="padding: 0">
        {#if running}
          <SpectrogramChart
            spectrum={dbWeighted}
            frameId={tick}
            {bins}
            {sampleRate}
            logFreq={true}
            minDb={-120}
            maxDb={0}
            colormap="viridis"
          />
        {:else}
          <div class="placeholder" style="height: 200px">Tap Start to render spectrogram</div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- DOMINANT -->
  <p class="section-header">Dominant frequencies · N = {$settings.audio.dominantFreqCount}</p>
  <section class="list-group" style="margin: 0 16px 16px">
    {#each dominant as d, i}
      <div class="list-row">
        <span class="dom-rank caption-1">#{i + 1}</span>
        <span class="list-row-label value-mono">{d.freq.toFixed(1)} <span class="footnote">Hz</span></span>
        <span class="footnote value-mono">{applyCal(20 * Math.log10(Math.max(d.mag, 1e-12))).toFixed(1)} {dbUnit}</span>
      </div>
    {:else}
      <div class="list-row footnote">No signal yet</div>
    {/each}
  </section>
</div>

<FooterControls module="audio" {running} onStart={start} onStop={stop} onResetKpi={resetKpi} />

{#if showWizard}
  <CalibrationWizard onClose={() => showWizard = false} />
{/if}

<style>
  .page {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0 12px;
    background: var(--bg-grouped);
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
  .calib-strip {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    margin: 0 16px;
  }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    padding: 0 16px;
  }
  @media (min-width: 480px) {
    .kpi-grid { grid-template-columns: repeat(4, 1fr); }
  }
  .chart-card { margin: 0 16px; overflow: hidden; }
  .card-head {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px;
    border-bottom: 0.5px solid var(--separator);
    flex-wrap: wrap;
  }
  .card-head select { padding: 6px 28px 6px 10px; min-height: 32px; font-size: var(--t-subhead); }
  .chart-host { padding: 8px; }
  .placeholder {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: var(--fg-tertiary); font-size: var(--t-footnote);
  }
  .dom-rank { width: 36px; color: var(--fg-tertiary); }
</style>
