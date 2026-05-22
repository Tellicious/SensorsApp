<!--
  Microphone calibration wizard.

  Two methods exposed to the user:
  - "External": user enters a reference SPL level from a measured source.
  - "Sensitivity": user enters mic sensitivity (dBFS @ 94 dB SPL),
                   which is just an offset.

  Bug fixed: radios previously used `bind:group={method}` but iOS Safari
  occasionally failed to capture the first tap (label-wrapped radios
  with bind:group are known to be flaky on Touch events). Replaced with
  explicit `onclick` handlers + `checked={method === 'X'}` for visual
  state. Also added an Escape key handler since users complained the
  sheet was hard to dismiss.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { settings, updateAudio } from '$lib/stores/settings';
  import { createAudioController, type AudioController } from '$lib/sensors/audio';

  type Method = 'external' | 'sensitivity' | 'none';
  let method = $state<Method>($settings.audio.calibration.method === 'none' ? 'external' : $settings.audio.calibration.method);

  let { onClose }: { onClose: () => void } = $props();

  // External-method state
  let refLevel = $state(94);
  let measuring = $state(false);
  let measuredDbfs = $state<number | null>(null);
  let measureWindow = $state(5); // seconds
  let progress = $state(0);

  // Sensitivity-method state
  let micSensitivityDbfs = $state(-22);

  // Result + standard deviation
  let computedOffset = $state<number | null>(null);
  let sigma = $state<number | null>(null);
  let saveError = $state<string | null>(null);

  let ctrl: AudioController | null = null;
  let samples: number[] = [];
  let rafId = 0;
  let measureStartT = 0;

  function setMethod(m: Method) {
    method = m;
    // Reset transient state when switching methods
    measuring = false;
    measuredDbfs = null;
    computedOffset = null;
    sigma = null;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  async function startMeasure() {
    if (measuring) return;
    saveError = null;
    measuredDbfs = null; computedOffset = null; sigma = null; samples = [];
    try {
      ctrl = await createAudioController(4096);
      await ctrl.start();
      measuring = true;
      measureStartT = performance.now();
      progress = 0;
      measureLoop();
    } catch (e) {
      saveError = (e as Error).message || 'Microphone access failed';
    }
  }

  function measureLoop() {
    if (!measuring || !ctrl) return;
    const buf = new Float32Array(ctrl.fftSize);
    ctrl.getTimeDomain(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / buf.length);
    if (rms > 0) samples.push(20 * Math.log10(rms));

    const elapsed = (performance.now() - measureStartT) / 1000;
    progress = Math.min(1, elapsed / measureWindow);

    if (elapsed >= measureWindow) {
      stopMeasure();
      return;
    }
    rafId = requestAnimationFrame(measureLoop);
  }

  function stopMeasure() {
    measuring = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (ctrl) { ctrl.stop(); ctrl = null; }
    if (samples.length < 10) {
      saveError = `Only ${samples.length} samples collected. Try again.`;
      return;
    }
    const m = samples.reduce((a, b) => a + b, 0) / samples.length;
    measuredDbfs = m;
    const varv = samples.reduce((a, b) => a + (b - m) ** 2, 0) / samples.length;
    sigma = Math.sqrt(varv);
    computedOffset = refLevel - m; // SPL = dBFS + offset
  }

  function saveExternal() {
    if (computedOffset === null) return;
    updateAudio({
      calibration: {
        offsetDb: computedOffset,
        method: 'external',
        referenceLevel: refLevel,
        sigma,
        calibratedAt: Date.now(),
        audioConstraintsHash: null
      }
    });
    onClose();
  }

  function saveSensitivity() {
    // Convention: SPL = dBFS - sensitivity + 94
    const offset = 94 - micSensitivityDbfs;
    updateAudio({
      calibration: {
        offsetDb: offset,
        method: 'sensitivity',
        referenceLevel: null,
        sigma: null,
        calibratedAt: Date.now(),
        audioConstraintsHash: null
      }
    });
    onClose();
  }

  function clearCalibration() {
    updateAudio({
      calibration: {
        offsetDb: 0, method: 'none',
        referenceLevel: null, sigma: null,
        calibratedAt: null, audioConstraintsHash: null
      }
    });
    onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }

  onMount(() => {
    document.addEventListener('keydown', onKey);
  });
  onDestroy(() => {
    document.removeEventListener('keydown', onKey);
    if (rafId) cancelAnimationFrame(rafId);
    if (ctrl) ctrl.stop();
  });
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label="Calibration">
  <header class="sheet-head">
    <span class="title">Microphone calibration</span>
    <button class="close-btn" onclick={onClose} aria-label="Close">✕</button>
  </header>

  <!-- Method picker — explicit onclick fixes iOS first-tap loss -->
  <div class="method-rows">
    <button
      type="button"
      class="method-row"
      class:selected={method === 'external'}
      onclick={() => setMethod('external')}
    >
      <span class="radio" class:checked={method === 'external'}></span>
      <span class="grow">
        <span class="headline">External reference</span>
        <span class="footnote">Use a known-level sound source.</span>
      </span>
    </button>
    <button
      type="button"
      class="method-row"
      class:selected={method === 'sensitivity'}
      onclick={() => setMethod('sensitivity')}
    >
      <span class="radio" class:checked={method === 'sensitivity'}></span>
      <span class="grow">
        <span class="headline">Mic sensitivity</span>
        <span class="footnote">Enter sensitivity in dBFS @ 94 dB SPL.</span>
      </span>
    </button>
  </div>

  {#if method === 'external'}
    <div class="form-block">
      <label class="row">
        <span class="row-label">Reference level</span>
        <input type="number" step="0.1" bind:value={refLevel} style="width: 100px; text-align: right" />
        <span class="footnote">dB SPL</span>
      </label>
      <label class="row">
        <span class="row-label">Measure window</span>
        <input type="number" step="1" min="2" max="30" bind:value={measureWindow} style="width: 100px; text-align: right" />
        <span class="footnote">s</span>
      </label>

      {#if !measuring && measuredDbfs === null}
        <button class="btn-filled" onclick={startMeasure}>Start measuring</button>
      {:else if measuring}
        <div class="meter">
          <div class="meter-bar"><div class="meter-fill" style="width: {progress * 100}%"></div></div>
          <span class="footnote">Measuring… {Math.round(progress * 100)}%</span>
        </div>
        <button class="btn-tinted" onclick={stopMeasure}>Stop early</button>
      {:else}
        <div class="result">
          <div class="result-row"><span>Measured (dBFS)</span><span class="value-mono">{measuredDbfs?.toFixed(2)}</span></div>
          <div class="result-row"><span>σ</span><span class="value-mono">{sigma?.toFixed(2)} dB</span></div>
          <div class="result-row"><span>Offset → SPL</span><span class="value-mono">+{computedOffset?.toFixed(2)} dB</span></div>
        </div>
        <div class="btn-row">
          <button class="btn-tinted" onclick={startMeasure}>Re-measure</button>
          <button class="btn-filled" onclick={saveExternal} disabled={computedOffset === null}>Save calibration</button>
        </div>
      {/if}
      {#if saveError}<p class="footnote" style="color: var(--danger)">{saveError}</p>{/if}
    </div>
  {:else}
    <div class="form-block">
      <label class="row">
        <span class="row-label">Sensitivity</span>
        <input type="number" step="0.1" bind:value={micSensitivityDbfs} style="width: 100px; text-align: right" />
        <span class="footnote">dBFS @ 94 dB SPL</span>
      </label>
      <p class="footnote">Offset will be <strong>+{(94 - micSensitivityDbfs).toFixed(2)} dB</strong>.</p>
      <button class="btn-filled" onclick={saveSensitivity}>Save calibration</button>
    </div>
  {/if}

  <div class="form-block" style="border-top: 0.5px solid var(--separator); margin-top: 8px">
    <button class="btn-plain destructive" onclick={clearCalibration}>Clear calibration</button>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.45);
    z-index: 100;
  }
  .sheet {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    max-height: 92vh;
    background: var(--bg-grouped);
    border-top-left-radius: 14px;
    border-top-right-radius: 14px;
    overflow-y: auto;
    z-index: 101;
    padding-bottom: calc(var(--safe-bottom) + 16px);
  }
  .sheet-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px;
    border-bottom: 0.5px solid var(--separator);
    background: var(--bg);
  }
  .title { font-size: var(--t-headline); font-weight: 600; color: var(--fg); }
  .close-btn {
    background: var(--fill-tertiary);
    color: var(--fg-secondary);
    border: none;
    width: 30px; height: 30px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 13px;
  }

  .method-rows {
    background: var(--bg-elev);
    margin: 16px;
    border-radius: var(--r-card);
    overflow: hidden;
  }
  .method-row {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 16px;
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 0.5px solid var(--separator);
    text-align: left;
    cursor: pointer;
    color: var(--fg);
    min-height: var(--touch);
  }
  .method-row:last-child { border-bottom: none; }
  .method-row:active { background: var(--fill-secondary); }
  .method-row.selected { background: var(--tint-dim); }
  .method-row .grow {
    flex: 1; display: flex; flex-direction: column; gap: 2px;
  }
  .radio {
    width: 22px; height: 22px;
    border-radius: 50%;
    border: 2px solid var(--separator);
    flex-shrink: 0;
    position: relative;
    transition: border-color 0.12s ease;
  }
  .radio.checked {
    border-color: var(--tint);
  }
  .radio.checked::after {
    content: '';
    position: absolute;
    inset: 4px;
    border-radius: 50%;
    background: var(--tint);
  }

  .form-block {
    padding: 12px 16px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .row {
    display: flex; align-items: center; gap: 12px;
    min-height: var(--touch);
  }
  .row-label { flex: 1; color: var(--fg); }
  input[type="number"] {
    background: var(--fill-tertiary);
    color: var(--fg);
    border: none;
    border-radius: var(--r-control);
    padding: 8px 12px;
    font-family: var(--mono);
  }
  .meter { display: flex; flex-direction: column; gap: 6px; }
  .meter-bar { height: 6px; background: var(--fill); border-radius: 3px; overflow: hidden; }
  .meter-fill { height: 100%; background: var(--tint); transition: width 0.1s linear; }
  .result {
    background: var(--bg-elev);
    border-radius: var(--r-card);
    padding: 12px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .result-row {
    display: flex; justify-content: space-between;
    font-size: var(--t-body);
  }
  .btn-row { display: flex; gap: 8px; }
  .btn-row > button { flex: 1; }
  .btn-filled, .btn-tinted, .btn-plain {
    min-height: var(--touch);
    border-radius: var(--r-control);
    border: none;
    padding: 10px 16px;
    font-weight: 500;
    cursor: pointer;
  }
  .btn-filled { background: var(--tint); color: #fff; }
  .btn-tinted { background: var(--tint-dim); color: var(--tint); }
  .btn-plain { background: transparent; color: var(--tint); text-align: left; padding: 12px 0; }
  .btn-plain.destructive { color: var(--danger); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
