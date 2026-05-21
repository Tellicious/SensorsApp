<!--
  KpiCard
  =======
  A single tappable KPI display tile in the iOS cards-grid style.

  Behavior:
  - Big monospaced number on the right, label and unit underneath
  - Tap anywhere on the card to invoke `onReset` (no separate reset icon —
    iOS prefers minimal chrome). The whole card is the touch target,
    well over the 44pt minimum.
  - Smart number formatting: precision adapts to magnitude so that we
    don't show `1e-05 m/s²` or fixed `0.000` everywhere.
-->
<script lang="ts">
  interface Props {
    /** Short label shown above the value (e.g. "RMS", "Peak"). */
    label: string;
    /** Current value. Strings are passed through verbatim. */
    value: string | number;
    /** Optional unit appended to the value (e.g. "m/s²", "dB"). */
    unit?: string;
    /** Reset handler. If omitted, the card is non-tappable. */
    onReset?: () => void;
    /** Render as a featured / larger tile (used for the headline KPI). */
    big?: boolean;
    /** Apply the tint accent border (used to highlight the primary KPI). */
    accent?: boolean;
  }
  let { label, value, unit = '', onReset, big = false, accent = false }: Props = $props();

  /**
   * Format a numeric value with magnitude-aware precision.
   * Strings pass through. Non-finite returns "—".
   */
  function fmt(v: string | number): string {
    if (typeof v === 'string') return v;
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(1);
    if (a >= 10) return v.toFixed(2);
    if (a >= 1) return v.toFixed(3);
    return v.toPrecision(3);
  }
</script>

<button
  type="button"
  class="kpi"
  class:big
  class:accent
  onclick={() => onReset?.()}
  title={onReset ? 'Tap to reset' : ''}
  disabled={!onReset}
>
  <span class="kpi-label">{label}</span>
  <span class="kpi-row">
    <span class={big ? 'value-large' : 'value-medium'}>{fmt(value)}</span>
    {#if unit}<span class="kpi-unit">{unit}</span>{/if}
  </span>
</button>

<style>
  .kpi {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: space-between;
    gap: 4px;
    padding: 12px 14px;
    background: var(--bg-elev);
    border: none;
    border-radius: var(--r-card);
    text-align: left;
    cursor: pointer;
    min-width: 0;
    min-height: 76px;
    color: var(--fg);
    font-weight: 400;
    transition: background 0.12s ease, transform 0.05s ease;
  }
  .kpi:not(:disabled):active {
    background: var(--bg-elev-2);
    transform: scale(0.98);
  }
  .kpi:disabled { cursor: default; }

  .kpi.accent {
    background: var(--tint-dim);
  }
  .kpi.big {
    padding: 16px;
    min-height: 96px;
  }

  .kpi-label {
    font-size: var(--t-footnote);
    font-weight: 500;
    color: var(--fg-secondary);
    letter-spacing: -0.08px;
  }
  .kpi-row {
    display: flex;
    align-items: baseline;
    gap: 4px;
    width: 100%;
  }
  .kpi-unit {
    font-size: var(--t-footnote);
    color: var(--fg-secondary);
    font-family: var(--mono);
  }
</style>
