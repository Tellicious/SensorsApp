<!--
  Inline FFT magnitude chart powered by uPlot.

  Same wrapper pattern as TimeChart: a small ⛶ button in the corner
  opens a ChartFullscreen overlay with touch-driven pan / zoom. Both
  inline and fullscreen instances read from the same magnitude buffer
  reference so the fullscreen view streams live.
-->
<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import ChartFullscreen from './ChartFullscreen.svelte';

  interface SeriesDef { label: string; color: string; }
  interface Props {
    freqs: Float32Array;
    spectra: Float32Array[];
    seriesDefs: SeriesDef[];
    logX?: boolean;
    logY?: boolean;
    autoScale?: boolean;
    yMin?: number;
    yMax?: number;
    fullscreenTitle?: string;
  }
  let {
    freqs, spectra, seriesDefs,
    logX = false, logY = true, autoScale = true,
    yMin, yMax,
    fullscreenTitle = ''
  }: Props = $props();

  let host: HTMLDivElement;
  let plot: uPlot | null = null;
  let rafId = 0;
  let showFull = $state(false);
  let resolvedColors = $state<string[]>([]);

  function resolveColor(c: string): string {
    if (!c.startsWith('var(')) return c;
    const name = c.slice(4, -1).trim();
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

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
    const f = Array.from(freqs) as number[];
    const data: uPlot.AlignedData = [f];
    for (const s of spectra) data.push(Array.from(s) as number[]);
    return data;
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
        x: { time: false, distr: logX ? 3 : 1 },
        y: {
          auto: autoScale,
          range: (!autoScale && yMin !== undefined && yMax !== undefined)
            ? [yMin, yMax] : undefined,
          distr: logY ? 1 : 1   // we feed dB values directly; the data IS log-amplitude
        }
      },
      axes: [
        { stroke: labelColor, grid: { stroke: tickColor, width: 0.5 }, ticks: { stroke: tickColor }, label: 'Hz' },
        { stroke: labelColor, grid: { stroke: tickColor, width: 0.5 }, ticks: { stroke: tickColor }, label: 'dB' }
      ],
      series: buildSeries()
    };
    plot = new uPlot(opts, buildData(), host);
  }

  function refresh() {
    if (!plot) return;
    plot.setData(buildData(), false);
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
    kind="fft"
    title={fullscreenTitle}
    {freqs} {spectra} {seriesDefs}
    {logX} {logY} {autoScale} {yMin} {yMax}
    yLabel="dB"
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
