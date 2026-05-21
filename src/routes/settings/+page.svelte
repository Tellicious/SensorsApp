<!--
  Settings page.

  Exposes every field in AllSettings, plus storage management and
  backup/restore. Laid out as iOS grouped lists — uppercase section
  header above each card, rows of label + control, separators between
  rows. Buttons follow iOS conventions: filled for affirmative,
  destructive (red) for wipe/reset, plain link-style for navigations.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    settings, resetSettings, exportSettingsJson, importSettingsJson,
    updateGlobal, updateMotion, updateAudio, updateGps,
    type Theme, type CoordFormat
  } from '$lib/stores/settings';
  import { FFT_SIZES } from '$lib/dsp/fft';
  import { WINDOW_NAMES, type WindowName } from '$lib/dsp/windowing';
  import { estimateUsage, wipe, db } from '$lib/storage/db';
  import { downloadAllSessionsZip } from '$lib/storage/csv';
  import CalibrationWizard from '$lib/components/CalibrationWizard.svelte';

  let usage = $state<{ usage: number; quota: number } | null>(null);
  let sessionCount = $state(0);
  let showCalWizard = $state(false);
  let importTextarea = $state('');
  let importError = $state<string | null>(null);

  /** Refresh the storage quota/usage display. */
  async function refreshStorage() {
    usage = await estimateUsage();
    sessionCount = await db.sessions.count();
  }
  onMount(refreshStorage);

  /** Human-friendly byte-size formatter. */
  function fmtBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  /** Copy settings JSON to clipboard AND prefill the import box (round-trip test). */
  function copyJson() {
    const json = exportSettingsJson();
    navigator.clipboard?.writeText(json);
    importTextarea = json;
  }

  function doImport() {
    importError = null;
    try {
      importSettingsJson(importTextarea);
      importTextarea = '';
    } catch (e) {
      importError = (e as Error).message;
    }
  }

  /** Download settings JSON as a file. */
  async function downloadJson() {
    const blob = new Blob([exportSettingsJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sensor-lab-settings_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function confirmWipe() {
    if (!confirm('Permanently delete ALL logged sessions and samples? This cannot be undone.')) return;
    await wipe();
    await refreshStorage();
  }

  async function resetAll() {
    if (!confirm('Reset all settings to defaults? Calibration will also be cleared.')) return;
    resetSettings();
  }
</script>

<div class="page">
  <!-- GLOBAL -->
  <p class="section-header">General</p>
  <section class="list-group">
    <div class="list-row">
      <span class="list-row-label">Theme</span>
      <select value={$settings.global.theme} onchange={(e) => updateGlobal({ theme: (e.currentTarget as HTMLSelectElement).value as Theme })}>
        <option value="auto">Automatic</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </div>
    <div class="list-row">
      <span class="list-row-label">Keep screen awake</span>
      <input type="checkbox" checked={$settings.global.wakeLock} onchange={(e) => updateGlobal({ wakeLock: (e.currentTarget as HTMLInputElement).checked })} />
    </div>
    <div class="list-row">
      <span class="list-row-label">Units</span>
      <select value={$settings.global.units} onchange={(e) => updateGlobal({ units: (e.currentTarget as HTMLSelectElement).value as 'si' | 'imperial' })}>
        <option value="si">Metric (SI)</option>
        <option value="imperial">Imperial</option>
      </select>
    </div>
  </section>

  <!-- MOTION -->
  <p class="section-header">Motion · channels</p>
  <section class="list-group">
    <div class="list-row"><span class="list-row-label">Show linear acceleration</span><input type="checkbox" checked={$settings.motion.showLinear} onchange={(e) => updateMotion({ showLinear: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Show raw (with gravity)</span><input type="checkbox" checked={$settings.motion.showRaw} onchange={(e) => updateMotion({ showRaw: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Show gyroscope</span><input type="checkbox" checked={$settings.motion.showGyro} onchange={(e) => updateMotion({ showGyro: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Show orientation</span><input type="checkbox" checked={$settings.motion.showOrientation} onchange={(e) => updateMotion({ showOrientation: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Show magnitude |a|</span><input type="checkbox" checked={$settings.motion.showMagnitude} onchange={(e) => updateMotion({ showMagnitude: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Axis X</span><input type="checkbox" checked={$settings.motion.axisX} onchange={(e) => updateMotion({ axisX: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Axis Y</span><input type="checkbox" checked={$settings.motion.axisY} onchange={(e) => updateMotion({ axisY: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Axis Z</span><input type="checkbox" checked={$settings.motion.axisZ} onchange={(e) => updateMotion({ axisZ: (e.currentTarget as HTMLInputElement).checked })} /></div>
  </section>

  <p class="section-header">Motion · FFT</p>
  <section class="list-group">
    <div class="list-row">
      <span class="list-row-label">Size</span>
      <select value={$settings.motion.fftSize} onchange={(e) => updateMotion({ fftSize: +(e.currentTarget as HTMLSelectElement).value as typeof FFT_SIZES[number] })}>
        {#each FFT_SIZES.filter(s => s <= 4096) as s}<option value={s}>{s}</option>{/each}
      </select>
    </div>
    <div class="list-row">
      <span class="list-row-label">Window</span>
      <select value={$settings.motion.fftWindow} onchange={(e) => updateMotion({ fftWindow: (e.currentTarget as HTMLSelectElement).value as WindowName })}>
        {#each WINDOW_NAMES as w}<option value={w}>{w}</option>{/each}
      </select>
    </div>
    <div class="list-row">
      <span class="list-row-label">Overlap</span>
      <select value={$settings.motion.fftOverlapPct} onchange={(e) => updateMotion({ fftOverlapPct: +(e.currentTarget as HTMLSelectElement).value as 0 | 25 | 50 | 75 })}>
        {#each [0, 25, 50, 75] as o}<option value={o}>{o}%</option>{/each}
      </select>
    </div>
    <div class="list-row"><span class="list-row-label">Y log (dB)</span><input type="checkbox" checked={$settings.motion.fftScaleLog} onchange={(e) => updateMotion({ fftScaleLog: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">X log frequency</span><input type="checkbox" checked={$settings.motion.fftFreqLog} onchange={(e) => updateMotion({ fftFreqLog: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Auto-scale Y</span><input type="checkbox" checked={$settings.motion.fftAutoScale} onchange={(e) => updateMotion({ fftAutoScale: (e.currentTarget as HTMLInputElement).checked })} /></div>
  </section>

  <p class="section-header">Motion · KPI windows</p>
  <section class="list-group">
    <div class="list-row">
      <span class="list-row-label">RMS window</span>
      <input type="number" step="0.1" min="0.1" max="60" value={$settings.motion.rmsWindowSec} oninput={(e) => updateMotion({ rmsWindowSec: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
      <span class="footnote">s</span>
    </div>
    <div class="list-row">
      <span class="list-row-label">Average window</span>
      <input type="number" step="0.5" min="0.5" max="60" value={$settings.motion.meanWindowSec} oninput={(e) => updateMotion({ meanWindowSec: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
      <span class="footnote">s</span>
    </div>
    <div class="list-row">
      <span class="list-row-label">Peak-hold decay</span>
      <input type="number" step="0.1" min="0" max="20" value={$settings.motion.peakHoldDecayDbPerSec} oninput={(e) => updateMotion({ peakHoldDecayDbPerSec: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
      <span class="footnote">dB/s</span>
    </div>
    <div class="list-row">
      <span class="list-row-label">Dominant freq count</span>
      <input type="number" step="1" min="1" max="20" value={$settings.motion.dominantFreqCount} oninput={(e) => updateMotion({ dominantFreqCount: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
    </div>
  </section>

  <!-- AUDIO -->
  <p class="section-header">Audio · display</p>
  <section class="list-group">
    <div class="list-row"><span class="list-row-label">Waveform</span><input type="checkbox" checked={$settings.audio.showWaveform} onchange={(e) => updateAudio({ showWaveform: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Spectrum</span><input type="checkbox" checked={$settings.audio.showSpectrum} onchange={(e) => updateAudio({ showSpectrum: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Spectrogram</span><input type="checkbox" checked={$settings.audio.showSpectrogram} onchange={(e) => updateAudio({ showSpectrogram: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row">
      <span class="list-row-label">Waveform window</span>
      <select value={$settings.audio.waveformWindowMs} onchange={(e) => updateAudio({ waveformWindowMs: +(e.currentTarget as HTMLSelectElement).value as 50 | 100 | 500 | 1000 })}>
        {#each [50, 100, 500, 1000] as w}<option value={w}>{w}ms</option>{/each}
      </select>
    </div>
  </section>

  <p class="section-header">Audio · FFT &amp; weighting</p>
  <section class="list-group">
    <div class="list-row">
      <span class="list-row-label">Size</span>
      <select value={$settings.audio.fftSize} onchange={(e) => updateAudio({ fftSize: +(e.currentTarget as HTMLSelectElement).value as typeof FFT_SIZES[number] })}>
        {#each FFT_SIZES as s}<option value={s}>{s}</option>{/each}
      </select>
    </div>
    <div class="list-row">
      <span class="list-row-label">Window</span>
      <select value={$settings.audio.fftWindow} onchange={(e) => updateAudio({ fftWindow: (e.currentTarget as HTMLSelectElement).value as WindowName })}>
        {#each WINDOW_NAMES as w}<option value={w}>{w}</option>{/each}
      </select>
    </div>
    <div class="list-row">
      <span class="list-row-label">Weighting</span>
      <select value={$settings.audio.weighting} onchange={(e) => updateAudio({ weighting: (e.currentTarget as HTMLSelectElement).value as 'Z' | 'A' | 'C' })}>
        <option value="Z">Z (flat)</option>
        <option value="A">A</option>
        <option value="C">C</option>
      </select>
    </div>
    <div class="list-row"><span class="list-row-label">X log frequency</span><input type="checkbox" checked={$settings.audio.fftFreqLog} onchange={(e) => updateAudio({ fftFreqLog: (e.currentTarget as HTMLInputElement).checked })} /></div>
  </section>

  <p class="section-header">Audio · microphone calibration</p>
  <section class="list-group">
    <div class="list-row" style="padding-top: 14px; padding-bottom: 14px">
      <div class="grow">
        {#if $settings.audio.calibration.method === 'none'}
          <div class="headline">Uncalibrated</div>
          <div class="footnote">Audio readings will display in dBFS only.</div>
        {:else}
          <div class="headline">+{$settings.audio.calibration.offsetDb.toFixed(1)} dB</div>
          <div class="footnote">
            Method {$settings.audio.calibration.method[0].toUpperCase()}
            {#if $settings.audio.calibration.calibratedAt}
              · {new Date($settings.audio.calibration.calibratedAt).toLocaleString()}
            {/if}
            {#if $settings.audio.calibration.sigma !== null}
              · σ {$settings.audio.calibration.sigma.toFixed(2)} dB
            {/if}
          </div>
        {/if}
      </div>
      <button class="btn-tinted btn-small" onclick={() => showCalWizard = true}>
        {$settings.audio.calibration.method === 'none' ? 'Calibrate' : 'Re-calibrate'}
      </button>
    </div>
  </section>

  <!-- GPS -->
  <p class="section-header">GPS</p>
  <section class="list-group">
    <div class="list-row">
      <span class="list-row-label">Coordinate format</span>
      <select value={$settings.gps.coordFormat} onchange={(e) => updateGps({ coordFormat: (e.currentTarget as HTMLSelectElement).value as CoordFormat })}>
        <option value="decimal">Decimal</option>
        <option value="dms">DMS</option>
      </select>
    </div>
    <div class="list-row">
      <span class="list-row-label">Movement threshold</span>
      <input type="number" step="0.1" min="0" max="10" value={$settings.gps.movementThresholdMps} oninput={(e) => updateGps({ movementThresholdMps: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
      <span class="footnote">m/s</span>
    </div>
    <div class="list-row"><span class="list-row-label">Show map</span><input type="checkbox" checked={$settings.gps.showMap} onchange={(e) => updateGps({ showMap: (e.currentTarget as HTMLInputElement).checked })} /></div>
    <div class="list-row"><span class="list-row-label">Show mini charts</span><input type="checkbox" checked={$settings.gps.showTimeCharts} onchange={(e) => updateGps({ showTimeCharts: (e.currentTarget as HTMLInputElement).checked })} /></div>
  </section>

  <!-- STORAGE -->
  <p class="section-header">Storage</p>
  <section class="list-group">
    {#if usage}
      <div class="list-row">
        <span class="list-row-label">Used</span>
        <span class="value-mono">{fmtBytes(usage.usage)}</span>
      </div>
      <div class="list-row">
        <span class="list-row-label">Quota</span>
        <span class="value-mono">{fmtBytes(usage.quota)}</span>
      </div>
      <div class="list-row">
        <span class="list-row-label">% used</span>
        <span class="value-mono">{((usage.usage / usage.quota) * 100).toFixed(2)}%</span>
      </div>
      <div class="list-row" style="padding-top: 0">
        <div class="bar"><div class="bar-fill" style="width: {(usage.usage / usage.quota) * 100}%"></div></div>
      </div>
    {/if}
    <div class="list-row">
      <span class="list-row-label">Sessions</span>
      <span class="value-mono">{sessionCount}</span>
    </div>
    <button class="list-row plain-row" onclick={refreshStorage}>Refresh</button>
    <button class="list-row plain-row" onclick={downloadAllSessionsZip}>Export all sessions as ZIP</button>
    <button class="list-row plain-row destructive" onclick={confirmWipe}>Wipe all sessions</button>
  </section>

  <!-- BACKUP/RESTORE -->
  <p class="section-header">Backup &amp; restore</p>
  <section class="list-group">
    <button class="list-row plain-row" onclick={copyJson}>Copy settings JSON to clipboard</button>
    <button class="list-row plain-row" onclick={downloadJson}>Download settings JSON</button>
    <button class="list-row plain-row destructive" onclick={resetAll}>Reset to defaults</button>
  </section>

  <section class="list-group" style="padding: 14px 16px">
    <span class="footnote">Paste a previously-exported JSON to restore settings</span>
    <textarea
      bind:value={importTextarea}
      placeholder="Paste exported settings JSON here"
      rows="5"
    ></textarea>
    <button class="btn-filled" onclick={doImport} disabled={!importTextarea.trim()} style="margin-top: 8px; width: 100%">
      Apply import
    </button>
    {#if importError}
      <p class="footnote" style="color: var(--danger); margin-top: 8px">{importError}</p>
    {/if}
  </section>

  <p class="footnote" style="text-align: center; padding: 16px">Sensor Lab · v0.1.0 · offline PWA</p>
</div>

{#if showCalWizard}
  <CalibrationWizard onClose={() => { showCalWizard = false; refreshStorage(); }} />
{/if}

<style>
  .page {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0 12px;
    background: var(--bg-grouped);
  }
  .section-header {
    font-size: var(--t-footnote);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 16px 6px 20px;
    font-weight: 400;
  }
  .plain-row {
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--tint);
    padding: 12px 16px;
    border-radius: 0;
    border: none;
    border-bottom: 0.5px solid var(--separator);
    min-height: var(--touch);
    font-weight: 400;
    font-size: var(--t-body);
  }
  .plain-row:last-child { border-bottom: none; }
  .plain-row:active:not(:disabled) { background: var(--fill-secondary); opacity: 1; }
  .plain-row.destructive { color: var(--danger); }

  .bar {
    height: 4px;
    background: var(--fill);
    border-radius: 2px;
    flex: 1;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    background: var(--tint);
    transition: width 0.2s ease;
  }
  textarea {
    width: 100%;
    min-height: 100px;
    background: var(--fill-tertiary);
    color: var(--fg);
    border: none;
    border-radius: var(--r-control);
    padding: 12px;
    font-family: var(--mono);
    font-size: var(--t-footnote);
    resize: vertical;
  }
</style>
