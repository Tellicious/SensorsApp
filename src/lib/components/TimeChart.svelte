<!--
  Inline time-series chart powered by uPlot.

  Features:
  - Auto-follows the head of the data (last `windowSec` of x).
  - Inline HTML legend (top-right) — the uPlot built-in legend is
    suppressed because it breaks layout on narrow phone widths.
  - "Fullscreen" affordance: when `fullscreenTitle` is supplied, a
    small ⛶ button in the top-right opens the ChartFullscreen overlay,
    which mounts a second uPlot instance with touch-driven pan / zoom.
    Both instances read from the same Float64 buffer references so the
    fullscreen view is live too.

  Buffers are mutated in place by the parent; the RAF reader picks up
  the latest values each frame without Svelte reactivity getting
  involved. This is also how the audio waveform now stays live (see
  the audio page's `timeBufF64` for the matching pre-allocated buffer).
-->
<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import ChartFullscreen from './ChartFullscreen.svelte';

  interface SeriesDef { label: string; color: string; }
  interface Props {
    xs: Float64Array;
    ys: Float64Array[];
    seriesDefs: SeriesDef[];
    count: number;
    windowSec: number;
    yMin?: number;
    yMax?: number;
    yLabel?: string;
    xLabel?: string;
    fullscreenTitle?: string;
  }
  let {
    xs, ys, seriesDefs, count, windowSec,
    yMin, yMax, yLabel = '', xLabel = 's',
    fullscreenTitle = ''
  }: Props = $props();

  let host: HTMLDivElement;
  let plot: uPlot | null = null;
  let rafId = 0;
  let showFull = $state(false);

  function resolveColor(c: string): string {
    if (!c.startsWith('var(')) return c;
    const name = c.slice(4, -1).trim();
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }
  // Resolved colors for the inline legend (Svelte template can't call functions
  // that depend on the DOM during SSR, so we compute them on mount)
  let resolvedColors = $state<string[]>([]);

  function buildSeries(): uPlot.Series[] {
    const arr: uPlot.Series[] = [{}];
    for (const def of seriesDefs) {
      arr.push({
        label: def.label,
        stroke: resolveColor(def.color),
        width: 1.4,
        spanGaps: false
      });
    }
    return arr;
  }

  function buildData(): uPlot.AlignedData {
    const n = Math.min(count, xs.length);
    const x = xs.subarray(0, n);
    const data: uPlot.AlignedData = [Array.from(x) as number[]];
    for (const y of ys) data.push(Array.from(y.subarray(0, n)) as number[]);
    return data;
  }

  function autoFollow() {
    if (!plot) return;
    const n = Math.min(count, xs.length);
    if (n < 2) return;
    const tEnd = xs[n - 1];
    plot.setScale('x', { min: Math.max(0, tEnd - windowSec), max: tEnd });
  }

  function mount() {
    if (!host) return;
    const tickColor  = getComputedStyle(document.documentElement).getPropertyValue('--separator').trim();
    const labelColor = getComputedStyle(document.documentElement).getPropertyValue('--fg-tertiary').trim();

    resolvedColors = seriesDefs.map(d => resolveColor(d.color));

    const opts: uPlot.Options = {
      width: host.clientWidth,
      height: host.clientHeight,
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { show: false } },
      scales: {
        x: { time: false },
        y: {
          auto: yMin === undefined && yMax === undefined,
          range: (yMin !== undefined && yMax !== undefined) ? [yMin, yMax] : undefined
        }
      },
      axes: [
        { stroke: labelColor, grid: { stroke: tickColor, width: 0.5 }, ticks: { stroke: tickColor }, label: xLabel },
        { stroke: labelColor, grid: { stroke: tickColor, width: 0.5 }, ticks: { stroke: tickColor }, label: yLabel }
      ],
      series: buildSeries()
    };
    plot = new uPlot(opts, buildData(), host);
    autoFollow();
  }

  function refresh() {
    if (!plot) return;
    plot.setData(buildData(), false);
    autoFollow();
    rafId = requestAnimationFrame(refresh);
  }

  function onResize() {
    if (!plot || !host) return;
    plot.setSize({ width: host.clientWidth, height: host.clientHeight });
  }

  onMount(() => {
    untrack(() => mount());
    rafId = requestAnimationFrame(refresh);
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(host);
    return () => ro.disconnect();
  });
  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    plot?.destroy();
    plot = null;
    window.removeEventListener('resize', onResize);
  });
</script>

<div class="chart-wrapper">
  <div bind:this={host} class="chart-host"></div>
  <div class="legend">
    {#each seriesDefs as def, i}
      <span class="legend-item">
        <span class="swatch" style="background: {resolvedColors[i] ?? def.color}"></span>
        <span>{def.label}</span>
      </span>
    {/each}
  </div>
  {#if fullscreenTitle}
    <button
      class="fullscreen-btn"
      onclick={() => showFull = true}
      aria-label="Expand to full screen"
    >⛶</button>
  {/if}
</div>

{#if showFull}
  <ChartFullscreen
    kind="time"
    title={fullscreenTitle}
    {xs} {ys} {seriesDefs} {count} {windowSec}
    {yMin} {yMax} {yLabel} {xLabel}
    onClose={() => showFull = false}
  />
{/if}

<style>
  .chart-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .chart-host { width: 100%; height: 100%; }
  .legend {
    position: absolute;
    top: 4px; right: 36px;
    display: flex; flex-wrap: wrap; gap: 8px;
    pointer-events: none;
  }
  .legend-item {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10px;
    color: var(--fg-secondary);
    background: var(--bg-elev);
    padding: 2px 6px;
    border-radius: var(--r-pill);
  }
  .swatch {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
  .fullscreen-btn {
    position: absolute;
    top: 4px; right: 4px;
    width: 28px; height: 28px;
    background: var(--fill-tertiary);
    color: var(--fg-secondary);
    border: none;
    border-radius: var(--r-control);
    font-size: 14px;
    cursor: pointer;
    z-index: 2;
  }
  .fullscreen-btn:active { opacity: 0.6; }
</style>
