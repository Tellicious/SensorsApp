<!--
  FooterControls
  ==============
  iOS-style toolbar pinned to the bottom of the page content (sits above
  the global tab bar in the layout). Houses the per-module action buttons:

    [ Start/Stop ]  [ Reset KPI ]  [ Rec/Stop ]  [ Export CSV ]

  Conventions:
  - The primary action (Start ↔ Stop) is a filled iOS pill button. When
    running, it switches to a destructive (red) "Stop" to follow the iOS
    convention of "destructive primary action".
  - The other three are tinted/plain buttons. They're disabled when the
    matching state is invalid (e.g. you can't reset KPIs when not running).
  - Logging is disabled when the active module is "audio" (per app spec:
    audio is visualization-only). The disabled-state tooltip explains why.

  Implementation notes:
  - The "Export CSV" button finds the most recent finished session for
    THIS module and triggers a download. Cross-module CSVs are not mixed.
  - The toolbar respects safe-area-inset-bottom indirectly via the parent
    layout, which adds the inset to the tab bar (the controls sit on top).
-->
<script lang="ts">
  import { sessionState, startLogging, stopLogging } from '$lib/stores/session';
  import type { ModuleKind } from '$lib/storage/db';
  import { db } from '$lib/storage/db';
  import { downloadSessionCsv } from '$lib/storage/csv';

  interface Props {
    /** Module identity. 'audio' has logging disabled. */
    module: ModuleKind | 'audio';
    /** Whether the sensor controller is currently active. */
    running: boolean;
    /** Called when the user taps Start. May be async (e.g. permission flow). */
    onStart: () => void | Promise<void>;
    /** Called when the user taps Stop. */
    onStop: () => void | Promise<void>;
    /** Called when the user taps Reset KPI. */
    onResetKpi: () => void;
  }

  let { module, running, onStart, onStop, onResetKpi }: Props = $props();

  const canLog = $derived(module !== 'audio');
  const logging = $derived($sessionState.active && $sessionState.module === module);

  /**
   * Toggle logging on/off. If the sensor controller isn't running yet,
   * starts it first — this matches the natural mental model of "tap Log
   * → it starts recording" without an extra Start step.
   */
  async function toggleLog() {
    if (logging) {
      await stopLogging();
    } else {
      if (!running) await onStart();
      await startLogging(module as ModuleKind);
    }
  }

  /**
   * Find the most recent session for this module and download it as CSV.
   * Shows a native alert if no session exists yet.
   */
  async function exportLast() {
    if (!canLog) return;
    const last = await db.sessions
      .where('module').equals(module)
      .reverse()
      .first();
    if (!last) {
      alert('No sessions for this module yet. Tap Log to record one first.');
      return;
    }
    await downloadSessionCsv(last);
  }
</script>

<div class="toolbar" role="toolbar" aria-label="Module controls">
  <button
    class={running ? 'btn-destructive' : 'btn-filled'}
    onclick={() => running ? onStop() : onStart()}
  >
    {running ? 'Stop' : 'Start'}
  </button>

  <button
    class="btn-tinted btn-small"
    onclick={onResetKpi}
    disabled={!running}
  >
    Reset
  </button>

  <button
    class={logging ? 'btn-warn btn-small' : 'btn-tinted btn-small'}
    onclick={toggleLog}
    disabled={!canLog}
    title={canLog ? '' : 'Logging not available for Audio module'}
  >
    {logging ? '● Rec' : 'Log'}
  </button>

  <button
    class="btn-tinted btn-small"
    onclick={exportLast}
    disabled={!canLog}
  >
    CSV
  </button>
</div>

<style>
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px 16px;
    background: var(--bg-elev);
    border-top: 0.5px solid var(--separator);
    /* primary action takes more space */
  }
  .toolbar > button:first-child {
    flex: 2 1 0;
  }
  .toolbar > button {
    flex: 1 1 0;
    min-width: 0;
  }
</style>
