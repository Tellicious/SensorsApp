<!--
  TimeChart
  =========
  Scrolling time-series chart based on uPlot. Hosts one or more series
  drawn against a shared X axis (seconds, relative to acquisition start).

  Inputs are pre-allocated typed arrays whose contents are mutated by the
  parent at sensor rate; the chart only reads them on its RAF tick and
  passes slices [0..count) to uPlot. Throttled to ~30 fps.

  CSS-variable color values can't be used directly in canvas, so we
  resolve them once at mount via getComputedStyle.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';

  interface SeriesDef { label: string; color: string }

  interface Props {
    /** Shared X-axis (seconds, relative). Pre-allocated; only [0..count) is valid. */
    xs: Float64Array;
    /** One Y buffer per series, same length as xs. */
    ys: Float64Array[];
    /** Labels and colors for each Y series. Color may be a CSS var or hex. */
    seriesDefs: SeriesDef[];
    /** Number of valid samples (writes the [0..count) slice). */
    count: number;
    /** Visible X-axis window in seconds (left = right − windowSec). */
    windowSec: number;
    /** Optional fixed Y range. If both null, uPlot auto-scales. */
    yMin?: number | null;
    yMax?: number | null;
    /** Optional Y-axis label. */
    yLabel?: string;
  }

  let {
    xs, ys, seriesDefs, count, windowSec,
    yMin = null, yMax = null, yLabel = ''
  }: Props = $props();

  let container: HTMLDivElement;
  let plot: uPlot | null = null;
  let frame = 0;

  /**
   * Resolve a CSS variable name (or "var(--name)" string) to its concrete
   * color value at the current root computed style. Canvas needs literal
   * colors, not CSS variables.
   */
  function resolveColor(value: string): string {
    if (!value.startsWith('var(')) return value;
    const name = value.slice(4, -1).trim();
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  /** Build the uPlot options object based on the props at mount time. */
  function makeOpts(w: number, h: number): uPlot.Options {
    const axisColor = resolveColor('var(--fg-secondary)');
    const gridColor = resolveColor('var(--grid)');
    const tickColor = resolveColor('var(--separator)');
    return {
      width: w,
      height: h,
      pxAlign: 0,
      cursor: { show: false },
      legend: { show: false },
      scales: {
        x: { time: false, auto: false },
        y: { auto: yMin === null || yMax === null }
      },
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: tickColor, width: 1 },
          values: (_u, splits) => splits.map((v) => v.toFixed(1) + 's')
        },
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: tickColor, width: 1 },
          label: yLabel,
          labelGap: 4,
          labelSize: 14
        }
      ],
      series: [
        {},
        ...seriesDefs.map((s) => ({
          label: s.label,
          stroke: resolveColor(s.color),
          width: 1.5,
          points: { show: false }
        }))
      ]
    };
  }

  /** Build the data array uPlot expects from the current slices. */
  function buildData(): uPlot.AlignedData {
    if (count === 0) {
      return [new Float64Array(1), ...ys.map(() => new Float64Array(1))] as unknown as uPlot.AlignedData;
    }
    return [xs.subarray(0, count), ...ys.map((y) => y.subarray(0, count))] as unknown as uPlot.AlignedData;
  }

  onMount(() => {
    plot = new uPlot(makeOpts(container.clientWidth, container.clientHeight), buildData(), container);

    const ro = new ResizeObserver(() => {
      if (!plot) return;
      plot.setSize({ width: container.clientWidth, height: container.clientHeight });
    });
    ro.observe(container);

    // RAF render loop, throttled to ~30 fps. Updates data, scrolls the X-axis
    // window so the latest sample is always at the right edge.
    let last = 0;
    const loop = (t: number) => {
      frame = requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t;
      if (!plot || count === 0) return;
      const xMax = xs[count - 1];
      const xMin = Math.max(0, xMax - windowSec);
      plot.setData(buildData(), false);
      plot.setScale('x', { min: xMin, max: xMax });
      if (yMin !== null && yMax !== null) plot.setScale('y', { min: yMin, max: yMax });
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  });

  onDestroy(() => { plot?.destroy(); plot = null; });
</script>

<div bind:this={container} class="chart"></div>

<style>
  .chart {
    width: 100%;
    height: 100%;
    min-height: 140px;
    position: relative;
  }
  :global(.uplot, .uplot *) {
    font-family: var(--mono) !important;
    font-size: 10px !important;
  }
</style>
