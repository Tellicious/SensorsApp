<!--
  Settings page.

  Layout follows iOS grouped-list convention. Native checkboxes have been
  replaced with iOS-style toggle switches wrapped in <label> elements so
  the entire row becomes the touch target. On iOS Safari the native
  checkbox is tiny (~16 pt), hard to tap, and `onchange` sometimes
  doesn't fire on the first touch — wrapping in a label and using a
  custom switch resolves both issues.

  New: per-KPI visibility for Motion / Audio / GPS (so the page can stay
  focused on the metrics the user cares about, while inline controls
  on each page handle which CHART axes are visible).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    settings, resetSettings, exportSettingsJson, importSettingsJson,
    updateGlobal, updateMotion, updateAudio, updateGps,
    setMotionKpi, setAudioKpi, setGpsKpi,
    type Theme, type CoordFormat, type MapProvider
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

  async function refreshStorage() {
    usage = await estimateUsage();
    sessionCount = await db.sessions.count();
  }
  onMount(refreshStorage);

  function fmtBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

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
    <label class="list-row">
      <span class="list-row-label">Theme</span>
      <select value={$settings.global.theme} onchange={(e) => updateGlobal({ theme: (e.currentTarget as HTMLSelectElement).value as Theme })}>
        <option value="auto">Automatic</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
    <label class="list-row">
      <span class="list-row-label">Keep screen awake</span>
      <span class="ios-toggle" class:on={$settings.global.wakeLock}>
        <input type="checkbox" checked={$settings.global.wakeLock} onchange={(e) => updateGlobal({ wakeLock: (e.currentTarget as HTMLInputElement).checked })} />
        <span class="track"></span><span class="knob"></span>
      </span>
    </label>
    <label class="list-row">
      <span class="list-row-label">Units</span>
      <select value={$settings.global.units} onchange={(e) => updateGlobal({ units: (e.currentTarget as HTMLSelectElement).value as 'si' | 'imperial' })}>
        <option value="si">Metric (SI)</option>
        <option value="imperial">Imperial</option>
      </select>
    </label>
  </section>

  <!-- MOTION channels -->
  <p class="section-header">Motion · channels</p>
  <section class="list-group">
    {#each [
      { k: 'showLinear', l: 'Show linear acceleration' },
      { k: 'showRaw', l: 'Show raw (with gravity)' },
      { k: 'showGyro', l: 'Show gyroscope' },
      { k: 'showOrientation', l: 'Show orientation' },
      { k: 'showMagnitude', l: 'Show magnitude |a|' }
    ] as t}
      <label class="list-row">
        <span class="list-row-label">{t.l}</span>
        <span class="ios-toggle" class:on={($settings.motion as Record<string, unknown>)[t.k] as boolean}>
          <input
            type="checkbox"
            checked={($settings.motion as Record<string, unknown>)[t.k] as boolean}
            onchange={(e) => updateMotion({ [t.k]: (e.currentTarget as HTMLInputElement).checked } as never)}
          />
          <span class="track"></span><span class="knob"></span>
        </span>
      </label>
    {/each}
  </section>

  <!-- MOTION KPI visibility -->
  <p class="section-header">Motion · KPI visibility</p>
  <section class="list-group">
    {#each [
      { k: 'peak', l: 'Peak' },
      { k: 'rms', l: 'RMS' },
      { k: 'avg', l: 'Avg' },
      { k: 'crest', l: 'Crest factor' },
      { k: 'kurt', l: 'Kurtosis' },
      { k: 'hold', l: 'Peak-hold' },
      { k: 'pkpk', l: 'Peak-to-peak' }
    ] as t}
      <label class="list-row">
        <span class="list-row-label">{t.l}</span>
        <span class="ios-toggle" class:on={($settings.motion.kpiVisible as Record<string, boolean>)[t.k]}>
          <input
            type="checkbox"
            checked={($settings.motion.kpiVisible as Record<string, boolean>)[t.k]}
            onchange={(e) => setMotionKpi(t.k as never, (e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="track"></span><span class="knob"></span>
        </span>
      </label>
    {/each}
  </section>

  <!-- MOTION FFT -->
  <p class="section-header">Motion · FFT</p>
  <section class="list-group">
    <label class="list-row">
      <span class="list-row-label">Size</span>
      <select value={$settings.motion.fftSize} onchange={(e) => updateMotion({ fftSize: +(e.currentTarget as HTMLSelectElement).value as typeof FFT_SIZES[number] })}>
        {#each FFT_SIZES.filter(s => s <= 4096) as s}<option value={s}>{s}</option>{/each}
      </select>
    </label>
    <label class="list-row">
      <span class="list-row-label">Window</span>
      <select value={$settings.motion.fftWindow} onchange={(e) => updateMotion({ fftWindow: (e.currentTarget as HTMLSelectElement).value as WindowName })}>
        {#each WINDOW_NAMES as w}<option value={w}>{w}</option>{/each}
      </select>
    </label>
    <label class="list-row">
      <span class="list-row-label">Overlap</span>
      <select value={$settings.motion.fftOverlapPct} onchange={(e) => updateMotion({ fftOverlapPct: +(e.currentTarget as HTMLSelectElement).value as 0 | 25 | 50 | 75 })}>
        {#each [0, 25, 50, 75] as o}<option value={o}>{o}%</option>{/each}
      </select>
    </label>
    {#each [
      { k: 'fftScaleLog', l: 'Y log (dB)' },
      { k: 'fftFreqLog', l: 'X log frequency' },
      { k: 'fftAutoScale', l: 'Auto-scale Y' }
    ] as t}
      <label class="list-row">
        <span class="list-row-label">{t.l}</span>
        <span class="ios-toggle" class:on={($settings.motion as Record<string, unknown>)[t.k] as boolean}>
          <input
            type="checkbox"
            checked={($settings.motion as Record<string, unknown>)[t.k] as boolean}
            onchange={(e) => updateMotion({ [t.k]: (e.currentTarget as HTMLInputElement).checked } as never)}
          />
          <span class="track"></span><span class="knob"></span>
        </span>
      </label>
    {/each}
  </section>

  <!-- MOTION KPI windows -->
  <p class="section-header">Motion · KPI windows</p>
  <section class="list-group">
    <label class="list-row">
      <span class="list-row-label">RMS window</span>
      <input type="number" step="0.1" min="0.1" max="60" value={$settings.motion.rmsWindowSec} oninput={(e) => updateMotion({ rmsWindowSec: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
      <span class="footnote">s</span>
    </label>
    <label class="list-row">
      <span class="list-row-label">Average window</span>
      <input type="number" step="0.5" min="0.5" max="60" value={$settings.motion.meanWindowSec} oninput={(e) => updateMotion({ meanWindowSec: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
      <span class="footnote">s</span>
    </label>
    <label class="list-row">
      <span class="list-row-label">Peak-hold decay</span>
      <input type="number" step="0.1" min="0" max="20" value={$settings.motion.peakHoldDecayDbPerSec} oninput={(e) => updateMotion({ peakHoldDecayDbPerSec: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
      <span class="footnote">dB/s</span>
    </label>
    <label class="list-row">
      <span class="list-row-label">Dominant freq count</span>
      <input type="number" step="1" min="1" max="20" value={$settings.motion.dominantFreqCount} oninput={(e) => updateMotion({ dominantFreqCount: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
    </label>
    <label class="list-row">
      <span class="list-row-label">Dominant smoothing</span>
      <input type="number" step="0.05" min="0" max="0.99" value={$settings.motion.dominantSmoothing} oninput={(e) => updateMotion({ dominantSmoothing: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
    </label>
  </section>

  <!-- AUDIO display -->
  <p class="section-header">Audio · display</p>
  <section class="list-group">
    {#each [
      { k: 'showWaveform', l: 'Waveform' },
      { k: 'showSpectrum', l: 'Spectrum' },
      { k: 'showSpectrogram', l: 'Spectrogram' }
    ] as t}
      <label class="list-row">
        <span class="list-row-label">{t.l}</span>
        <span class="ios-toggle" class:on={($settings.audio as Record<string, unknown>)[t.k] as boolean}>
          <input
            type="checkbox"
            checked={($settings.audio as Record<string, unknown>)[t.k] as boolean}
            onchange={(e) => updateAudio({ [t.k]: (e.currentTarget as HTMLInputElement).checked } as never)}
          />
          <span class="track"></span><span class="knob"></span>
        </span>
      </label>
    {/each}
    <label class="list-row">
      <span class="list-row-label">Waveform window</span>
      <select value={$settings.audio.waveformWindowMs} onchange={(e) => updateAudio({ waveformWindowMs: +(e.currentTarget as HTMLSelectElement).value as 50 | 100 | 500 | 1000 })}>
        {#each [50, 100, 500, 1000] as w}<option value={w}>{w}ms</option>{/each}
      </select>
    </label>
  </section>

  <!-- AUDIO KPI visibility -->
  <p class="section-header">Audio · KPI visibility</p>
  <section class="list-group">
    {#each [
      { k: 'peak', l: 'Peak' },
      { k: 'rms', l: 'RMS / Leq' },
      { k: 'crest', l: 'Crest factor' }
    ] as t}
      <label class="list-row">
        <span class="list-row-label">{t.l}</span>
        <span class="ios-toggle" class:on={($settings.audio.kpiVisible as Record<string, boolean>)[t.k]}>
          <input
            type="checkbox"
            checked={($settings.audio.kpiVisible as Record<string, boolean>)[t.k]}
            onchange={(e) => setAudioKpi(t.k as never, (e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="track"></span><span class="knob"></span>
        </span>
      </label>
    {/each}
  </section>

  <!-- AUDIO FFT -->
  <p class="section-header">Audio · FFT &amp; weighting</p>
  <section class="list-group">
    <label class="list-row">
      <span class="list-row-label">Size</span>
      <select value={$settings.audio.fftSize} onchange={(e) => updateAudio({ fftSize: +(e.currentTarget as HTMLSelectElement).value as typeof FFT_SIZES[number] })}>
        {#each FFT_SIZES as s}<option value={s}>{s}</option>{/each}
      </select>
    </label>
    <label class="list-row">
      <span class="list-row-label">Window</span>
      <select value={$settings.audio.fftWindow} onchange={(e) => updateAudio({ fftWindow: (e.currentTarget as HTMLSelectElement).value as WindowName })}>
        {#each WINDOW_NAMES as w}<option value={w}>{w}</option>{/each}
      </select>
    </label>
    <label class="list-row">
      <span class="list-row-label">Weighting</span>
      <select value={$settings.audio.weighting} onchange={(e) => updateAudio({ weighting: (e.currentTarget as HTMLSelectElement).value as 'Z' | 'A' | 'C' })}>
        <option value="Z">Z (flat)</option>
        <option value="A">A</option>
        <option value="C">C</option>
      </select>
    </label>
    <label class="list-row">
      <span class="list-row-label">X log frequency</span>
      <span class="ios-toggle" class:on={$settings.audio.fftFreqLog}>
        <input type="checkbox" checked={$settings.audio.fftFreqLog} onchange={(e) => updateAudio({ fftFreqLog: (e.currentTarget as HTMLInputElement).checked })} />
        <span class="track"></span><span class="knob"></span>
      </span>
    </label>
    <label class="list-row">
      <span class="list-row-label">Dominant smoothing</span>
      <input type="number" step="0.05" min="0" max="0.99" value={$settings.audio.dominantSmoothing} oninput={(e) => updateAudio({ dominantSmoothing: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
    </label>
  </section>

  <!-- AUDIO calibration -->
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
    <label class="list-row">
      <span class="list-row-label">Coordinate format</span>
      <select value={$settings.gps.coordFormat} onchange={(e) => updateGps({ coordFormat: (e.currentTarget as HTMLSelectElement).value as CoordFormat })}>
        <option value="decimal">Decimal</option>
        <option value="dms">DMS</option>
      </select>
    </label>
    <label class="list-row">
      <span class="list-row-label">Movement threshold</span>
      <input type="number" step="0.1" min="0" max="10" value={$settings.gps.movementThresholdMps} oninput={(e) => updateGps({ movementThresholdMps: +(e.currentTarget as HTMLInputElement).value })} style="width: 80px; text-align: right" />
      <span class="footnote">m/s</span>
    </label>
    {#each [
      { k: 'showMap', l: 'Show map' },
      { k: 'showTimeCharts', l: 'Show mini charts' }
    ] as t}
      <label class="list-row">
        <span class="list-row-label">{t.l}</span>
        <span class="ios-toggle" class:on={($settings.gps as Record<string, unknown>)[t.k] as boolean}>
          <input
            type="checkbox"
            checked={($settings.gps as Record<string, unknown>)[t.k] as boolean}
            onchange={(e) => updateGps({ [t.k]: (e.currentTarget as HTMLInputElement).checked } as never)}
          />
          <span class="track"></span><span class="knob"></span>
        </span>
      </label>
    {/each}
  </section>

  <!-- GPS map provider -->
  <p class="section-header">GPS · map provider</p>
  <section class="list-group">
    <label class="list-row">
      <span class="list-row-label">Provider</span>
      <select value={$settings.gps.mapProvider} onchange={(e) => updateGps({ mapProvider: (e.currentTarget as HTMLSelectElement).value as MapProvider })}>
        <option value="apple">Apple Maps (MapKit JS)</option>
        <option value="carto">CartoDB Voyager</option>
        <option value="osm">OpenStreetMap</option>
      </select>
    </label>
    <label class="list-row">
      <span class="list-row-label">MapKit JS token</span>
      <input type="text" value={$settings.gps.appleMapsToken} oninput={(e) => updateGps({ appleMapsToken: (e.currentTarget as HTMLInputElement).value })} placeholder="JWT — required for Apple Maps" style="flex: 1; min-width: 0; font-family: var(--mono); font-size: var(--t-footnote)" />
    </label>
    <div class="list-row footnote" style="display: block; line-height: 1.45; color: var(--fg-tertiary)">
      Apple Maps web (MapKit JS) requires a signed JWT issued from your Apple
      Developer account — there is no public/anonymous tier. If no token is
      provided, the map falls back to CartoDB Voyager which is free and visually
      closer to Apple Maps than the default OSM tiles.
    </div>
  </section>

  <!-- GPS KPI visibility -->
  <p class="section-header">GPS · KPI visibility</p>
  <section class="list-group">
    {#each [
      { k: 'distance', l: 'Distance' },
      { k: 'speedMax', l: 'Speed max' },
      { k: 'speedMin', l: 'Speed min' },
      { k: 'speedAvg', l: 'Speed avg' },
      { k: 'speedMedian', l: 'Speed median' },
      { k: 'timeMoving', l: 'Time moving' },
      { k: 'heading', l: 'Heading' },
      { k: 'accuracy', l: 'Accuracy' }
    ] as t}
      <label class="list-row">
        <span class="list-row-label">{t.l}</span>
        <span class="ios-toggle" class:on={($settings.gps.kpiVisible as Record<string, boolean>)[t.k]}>
          <input
            type="checkbox"
            checked={($settings.gps.kpiVisible as Record<string, boolean>)[t.k]}
            onchange={(e) => setGpsKpi(t.k as never, (e.currentTarget as HTMLInputElement).checked)}
          />
          <span class="track"></span><span class="knob"></span>
        </span>
      </label>
    {/each}
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
    <textarea bind:value={importTextarea} placeholder="Paste exported settings JSON here" rows="5"></textarea>
    <button class="btn-filled" onclick={doImport} disabled={!importTextarea.trim()} style="margin-top: 8px; width: 100%">
      Apply import
    </button>
    {#if importError}
      <p class="footnote" style="color: var(--danger); margin-top: 8px">{importError}</p>
    {/if}
  </section>

  <p class="footnote" style="text-align: center; padding: 16px">Sensor Lab · v0.2.0 · offline PWA</p>
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
    -webkit-overflow-scrolling: touch;
  }
  .section-header {
    font-size: var(--t-footnote);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 16px 6px 20px;
    font-weight: 400;
  }
  .list-row {
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
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

  /* iOS-style toggle switch. The native input is visually hidden but
     remains accessible to assistive tech / keyboard. The track/knob
     are styled via :checked sibling selectors so a click on either the
     wrapping <label> row OR the input itself flips state correctly. */
  .ios-toggle {
    position: relative;
    display: inline-block;
    width: 51px;
    height: 31px;
    flex-shrink: 0;
  }
  .ios-toggle input {
    position: absolute;
    opacity: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    cursor: pointer;
    z-index: 2;
  }
  .ios-toggle .track {
    position: absolute;
    inset: 0;
    background: var(--fill);
    border-radius: 31px;
    transition: background 0.18s ease;
  }
  .ios-toggle .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    background: #ffffff;
    border-radius: 50%;
    box-shadow: 0 2px 4px rgba(0,0,0,0.15);
    transition: transform 0.18s ease;
  }
  .ios-toggle.on .track { background: var(--success); }
  .ios-toggle.on .knob { transform: translateX(20px); }
</style>
