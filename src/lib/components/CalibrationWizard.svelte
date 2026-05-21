<!--
  CalibrationWizard
  =================
  Multi-step wizard that converts dBFS readouts into true dB SPL by
  computing an additive dB offset. Presented as an iOS modal sheet.

  Three methods, per spec:
    A. External reference — recommended, accurate.
       Use a pistonphone (94 / 114 dB SPL @ 1 kHz) or another already-
       calibrated SPL meter on a second device. Wizard performs:
         1. 3-second countdown
         2. 10-second Leq integration with the chosen weighting (A or Z)
         3. offset = referenceLevel − Leq_measured
         4. Report σ of the per-frame levels as a stability sanity check
            (σ > 1 dB ⇒ ambient noise unstable, advise retry)

    B. Manual sensitivity — theoretical, accuracy limited.
       User provides microphone sensitivity in dBV/Pa plus any preamp
       gain. Computes offset using 1 Pa = 94 dB SPL convention:
         offset = 94 − (sensitivity_dBV/Pa + preamp_gain_dB)

    C. Skip — work in dBFS only. Offset 0, calibration method "none".

  Persists into settings.audio.calibration which all audio displays read.

  iOS styling: full-screen sheet on phones, rounded top, drag handle,
  navigation bar with Cancel (left) / Done (right) — kept minimal here
  with a single ✕ close button for simplicity.
-->
<script lang="ts">
  import { createAudioController } from '$lib/sensors/audio';
  import { settings, updateAudio } from '$lib/stores/settings';
  import { weightedBroadbandDb, weightingOffsets } from '$lib/dsp/weighting';

  interface Props { onClose: () => void }
  let { onClose }: Props = $props();

  type Step =
    | 'method'           // pick A/B/C
    | 'externalSetup'    // method A — configure reference level + weighting
    | 'externalMeasure'  // method A — running countdown + 10s integration
    | 'externalResult'   // method A — show offset + σ, save/retry
    | 'sensitivity'      // method B — enter sensitivity and preamp gain
    | 'skipConfirm';     // method C — confirm dBFS-only mode

  let step = $state<Step>('method');
  let method = $state<'external' | 'sensitivity' | 'none'>('external');

  // ---- Method A state ----
  let referenceLevel = $state(94.0);          // dB SPL of the calibration source
  let measuredOffset = $state<number | null>(null);
  let sigma = $state<number | null>(null);    // per-frame stddev of measured levels
  let countdown = $state(0);                   // 3..2..1
  let measureProgress = $state(0);             // 0..1 across the 10s integration
  let usingWeightDuringCal = $state<'Z' | 'A'>('A');

  // ---- Method B state ----
  let sensitivityDbvPerPa = $state(-38);       // typical mic ~ -38 dBV/Pa
  let preampGainDb = $state(0);

  /** Yield to the event loop for `ms`. Used for countdown / pacing. */
  function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

  /**
   * Method A worker: 3s countdown → 10s of audio sampled @ 10 Hz, each
   * frame contributes a weighted broadband level. Final offset is
   * referenceLevel − Leq(10s), σ is the std deviation of per-frame levels.
   */
  async function runExternalMeasurement() {
    step = 'externalMeasure';
    const ctrl = await createAudioController(8192);
    await ctrl.start();

    const samplesPerSec = 10;
    const totalSec = 10;
    const bins = ctrl.fftSize / 2;
    const freqs = new Float32Array(bins);
    for (let k = 0; k < bins; k++) freqs[k] = (k * ctrl.sampleRate) / ctrl.fftSize;
    const offsetsAt = weightingOffsets(freqs, usingWeightDuringCal);
    const mag = new Float32Array(bins);
    const levels: number[] = [];

    // 3-second countdown so the user can position the device
    for (let s = 3; s > 0; s--) { countdown = s; await sleep(1000); }
    countdown = 0;

    // 10-second sampling loop
    const start = performance.now();
    while (performance.now() - start < totalSec * 1000) {
      ctrl.getFrequencyMag(mag);
      const dbfsWeighted = weightedBroadbandDb(mag, offsetsAt);
      levels.push(dbfsWeighted);
      measureProgress = (performance.now() - start) / (totalSec * 1000);
      await sleep(1000 / samplesPerSec);
    }
    await ctrl.stop();

    // Leq from per-frame energy mean
    let pSum = 0;
    for (const L of levels) pSum += Math.pow(10, L / 10);
    const Leq = 10 * Math.log10(pSum / levels.length);

    // σ on the dB-domain samples (a rough stability indicator)
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    const variance = levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length;
    sigma = Math.sqrt(variance);

    measuredOffset = referenceLevel - Leq;
    step = 'externalResult';
  }

  function saveExternal() {
    if (measuredOffset === null) return;
    updateAudio({
      calibration: {
        offsetDb: measuredOffset,
        method: 'external',
        referenceLevel,
        sigma,
        calibratedAt: Date.now(),
        audioConstraintsHash: 'default-mic'
      }
    });
    onClose();
  }

  /**
   * Method B: derive offset from published sensitivity.
   * At 1 Pa the mic outputs `sensitivity + preampGain` dBFS.
   * Since 1 Pa = 94 dB SPL by convention, offset = 94 − dBFS_at_1Pa.
   */
  function saveSensitivity() {
    const dbfsAt1Pa = sensitivityDbvPerPa + preampGainDb;
    const offsetDb = 94 - dbfsAt1Pa;
    updateAudio({
      calibration: {
        offsetDb,
        method: 'sensitivity',
        referenceLevel: null,
        sigma: null,
        calibratedAt: Date.now(),
        audioConstraintsHash: 'default-mic'
      }
    });
    onClose();
  }

  /** Method C: clear calibration, work in dBFS. */
  function saveSkip() {
    updateAudio({
      calibration: {
        offsetDb: 0,
        method: 'none',
        referenceLevel: null,
        sigma: null,
        calibratedAt: Date.now(),
        audioConstraintsHash: null
      }
    });
    onClose();
  }
</script>

<div class="overlay" onclick={onClose} role="presentation"></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label="Microphone calibration wizard">
  <!-- iOS-style drag handle -->
  <div class="handle"></div>

  <header>
    <button class="btn-plain" onclick={onClose}>Cancel</button>
    <span class="headline">Calibrate</span>
    <span style="min-width: 60px"></span>
  </header>

  {#if step === 'method'}
    <div class="body">
      <p class="footnote">Choose how to calibrate. Method A gives true dB SPL; method C keeps everything in dBFS.</p>

      <div class="list-group" style="margin: 0">
        <label class="list-row method-row">
          <input type="radio" bind:group={method} value="external" />
          <div class="grow">
            <div class="headline">A — External reference</div>
            <div class="footnote">Pistonphone (94 / 114 dB SPL) or another calibrated SPL meter on a second device.</div>
          </div>
        </label>
        <label class="list-row method-row">
          <input type="radio" bind:group={method} value="sensitivity" />
          <div class="grow">
            <div class="headline">B — Manual sensitivity</div>
            <div class="footnote">You know the mic sensitivity in dBV/Pa. Theoretical, accuracy limited.</div>
          </div>
        </label>
        <label class="list-row method-row">
          <input type="radio" bind:group={method} value="none" />
          <div class="grow">
            <div class="headline">C — Skip (dBFS only)</div>
            <div class="footnote">Work in dB full-scale without an absolute SPL reference.</div>
          </div>
        </label>
      </div>

      <div class="actions">
        <button class="btn-filled" onclick={() => {
          if (method === 'external') step = 'externalSetup';
          else if (method === 'sensitivity') step = 'sensitivity';
          else step = 'skipConfirm';
        }}>Continue</button>
      </div>
    </div>
  {/if}

  {#if step === 'externalSetup'}
    <div class="body">
      <ol class="instructions">
        <li>Place the calibration source (or reference meter) right next to your iPhone microphone.</li>
        <li>Make sure the environment is quiet — the source should dominate.</li>
        <li>Enter the expected level below, then start. A 3-second countdown precedes a 10-second measurement.</li>
      </ol>

      <div class="list-group" style="margin: 0">
        <div class="list-row">
          <span class="list-row-label">Reference level</span>
          <input type="number" step="0.1" bind:value={referenceLevel} style="width: 110px; text-align: right" />
          <span class="footnote">dB SPL</span>
        </div>
        <div class="list-row">
          <span class="list-row-label">Weighting during cal</span>
          <select bind:value={usingWeightDuringCal} style="width: 130px">
            <option value="A">A (recommended)</option>
            <option value="Z">Z (flat)</option>
          </select>
        </div>
      </div>

      <div class="actions">
        <button class="btn-gray" onclick={() => step = 'method'}>Back</button>
        <button class="btn-filled" onclick={runExternalMeasurement}>Start</button>
      </div>
    </div>
  {/if}

  {#if step === 'externalMeasure'}
    <div class="body" style="text-align: center; padding: 40px 16px">
      {#if countdown > 0}
        <div style="font-size: 80px; font-weight: 200; font-family: var(--mono); color: var(--tint)">{countdown}</div>
        <div class="footnote">Get ready…</div>
      {:else}
        <div class="title-2" style="margin-bottom: 18px">Measuring</div>
        <div class="progress"><div class="progress-fill" style="width: {measureProgress * 100}%"></div></div>
        <div class="footnote" style="margin-top: 18px">10-second integration in progress</div>
      {/if}
    </div>
  {/if}

  {#if step === 'externalResult' && measuredOffset !== null}
    <div class="body">
      <div class="result-row">
        <div>
          <div class="footnote">Offset</div>
          <div class="value-large">{measuredOffset.toFixed(1)}<span class="value-unit">dB</span></div>
        </div>
        <div>
          <div class="footnote">σ</div>
          <div class="value-large" style:color={sigma! > 1 ? 'var(--warn)' : 'var(--success)'}>
            {sigma?.toFixed(2)}<span class="value-unit">dB</span>
          </div>
        </div>
      </div>
      {#if sigma! > 1}
        <p class="footnote" style="color: var(--warn)">
          Environment unstable (σ &gt; 1 dB). Consider retrying in a quieter room.
        </p>
      {/if}
      <div class="actions">
        <button class="btn-gray" onclick={() => step = 'externalSetup'}>Retry</button>
        <button class="btn-filled" onclick={saveExternal}>Save</button>
      </div>
    </div>
  {/if}

  {#if step === 'sensitivity'}
    <div class="body">
      <p class="footnote">Enter the published microphone sensitivity. Useful for external USB / Lightning mics with known specs.</p>
      <div class="list-group" style="margin: 0">
        <div class="list-row">
          <span class="list-row-label">Sensitivity</span>
          <input type="number" step="0.1" bind:value={sensitivityDbvPerPa} style="width: 110px; text-align: right" />
          <span class="footnote">dBV/Pa</span>
        </div>
        <div class="list-row">
          <span class="list-row-label">Preamp gain</span>
          <input type="number" step="0.5" bind:value={preampGainDb} style="width: 110px; text-align: right" />
          <span class="footnote">dB</span>
        </div>
        <div class="list-row">
          <span class="list-row-label">Computed offset</span>
          <span class="value-mono headline">{(94 - sensitivityDbvPerPa - preampGainDb).toFixed(1)} dB</span>
        </div>
      </div>
      <p class="footnote" style="color: var(--warn)">Theoretical value — accuracy limited compared to method A.</p>
      <div class="actions">
        <button class="btn-gray" onclick={() => step = 'method'}>Back</button>
        <button class="btn-filled" onclick={saveSensitivity}>Save</button>
      </div>
    </div>
  {/if}

  {#if step === 'skipConfirm'}
    <div class="body">
      <p>Calibration will be cleared. Audio readouts will display in <strong>dBFS</strong> (or dB(A)/dB(C) when weighting is active) without an SPL reference.</p>
      <div class="actions">
        <button class="btn-gray" onclick={() => step = 'method'}>Back</button>
        <button class="btn-filled" onclick={saveSkip}>Confirm</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 100;
    animation: fadeIn 0.2s ease;
  }
  .sheet {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    background: var(--bg-grouped);
    border-radius: 14px 14px 0 0;
    z-index: 101;
    max-height: 92vh;
    overflow-y: auto;
    padding-bottom: var(--safe-bottom);
    animation: slideUp 0.25s ease;
  }
  @media (min-width: 600px) {
    .sheet {
      left: 50%; right: auto; bottom: auto;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 480px;
      max-height: 80vh;
      border-radius: 14px;
      animation: fadeIn 0.2s ease;
    }
  }
  @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
  @keyframes slideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }

  .handle {
    width: 36px;
    height: 5px;
    background: var(--fg-tertiary);
    border-radius: 3px;
    margin: 6px auto 0;
  }
  @media (min-width: 600px) {
    .handle { display: none; }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 8px 12px;
  }
  header .headline {
    color: var(--fg);
  }
  .body {
    padding: 8px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .footnote { color: var(--fg-secondary); font-size: var(--t-footnote); margin: 0; }
  .actions { display: flex; gap: 8px; justify-content: stretch; margin-top: 8px; }
  .actions button { flex: 1; }

  .method-row {
    align-items: flex-start;
    cursor: pointer;
    gap: 14px;
  }
  .method-row input[type=radio] {
    accent-color: var(--tint);
    margin-top: 2px;
  }
  .method-row .headline { color: var(--fg); }

  .instructions {
    margin: 0;
    padding-left: 22px;
    line-height: 1.6;
    font-size: var(--t-callout);
  }

  .progress {
    height: 4px;
    background: var(--fill);
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--tint);
    transition: width 0.1s linear;
  }

  .result-row {
    display: flex;
    gap: 24px;
    padding: 16px;
    background: var(--bg-elev);
    border-radius: var(--r-card);
    justify-content: space-around;
  }
  .value-unit {
    font-size: var(--t-footnote);
    color: var(--fg-secondary);
    margin-left: 4px;
    font-family: var(--mono);
  }
</style>
