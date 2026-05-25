<!--
  FftChart
  ========
  Spectrum display based on uPlot. One or more magnitude/dB series share
  a common frequency axis. Supports linear or logarithmic X (frequency)
  and Y (dB vs linear). Fixed-range or auto-scaled Y.

  Like TimeChart, CSS variable colors are resolved to literal values at
  mount time so canvas2D understands them.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';

  interface SeriesDef { label: string; color: string }

  interface Props {
    /** Bin-center frequencies in Hz. */
    freqs: Float32Array;
    /** Magnitude or dB array per series, same length as `freqs`. */
    spectra: Float32Array[];
    /** One label + color per series. */
    seriesDefs: SeriesDef[];
    /** Use logarithmic Y axis (dB) vs linear magnitude. */
    logY: boolean;
    /** Use logarithmic X axis (frequency). */
    logX: boolean;
    /** Fixed Y minimum (used only when autoScale is false). */
    yMin?: number;
    /** Fixed Y maximum. */
    yMax?: number;
    /** If true, ignore yMin/yMax and let uPlot pick. */
    autoScale: boolean;
    /** Optional Y-axis label. */
    yLabel?: string;
  }

  let {
    freqs, spectra, seriesDefs, logY, logX,
    yMin = -120, yMax = 0, autoScale = true,
    yLabel = 'dB'
  }: Props = $props();

  let container: HTMLDivElement;
  let plot: uPlot | null = null;
  let frame = 0;

  /** Resolve CSS variable to literal color value. See TimeChart for rationale. */
  function resolveColor(value: string): string {
    if (!value.startsWith('var(')) return value;
    const name = value.slice(4, -1).trim();
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  function makeOpts(w: number, h: number): uPlot.Options {
    const axisColor = resolveColor('var(--fg-secondary)');
    const gridColor = resolveColor('var(--grid)');
    const tickColor = resolveColor('var(--separator)');
    void logY;
    return {
      width: w,
      height: h,
      pxAlign: 0,
      cursor: { show: true, x: true, y: false },
      legend: { show: false },
      scales: {
        // uPlot scale distribution: 1=linear, 3=log. Y log-axis is handled
        // by feeding dB values (precomputed elsewhere), not via scale.distr.
        x: { time: false, distr: logX ? 3 : 1 },
        y: { auto: autoScale, distr: 1 }
      },
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: tickColor, width: 1 },
          values: (_u, splits) =>
            splits.map((v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0) + 'Hz'))
        },
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 1 },
          ticks: { stroke: tickColor, width: 1 },
          label: yLabel,
          labelGap: 4,
          labelSize: 14,
          // uPlot's default Y-axis gutter (~50px) clips 4-char labels like
          // "-100" — widen so negative signs and 3-digit values fit.
          size: 58
        }
      ],
      series: [
        {},
        ...seriesDefs.map((s) => ({
          label: s.label,
          stroke: resolveColor(s.color),
          width: 1.2,
          points: { show: false }
        }))
      ]
    };
  }

  function buildData(): uPlot.AlignedData {
    return [freqs, ...spectra] as unknown as uPlot.AlignedData;
  }

  onMount(() => {
    plot = new uPlot(makeOpts(container.clientWidth, container.clientHeight), buildData(), container);

    // Suppress iOS Safari's auto-injected canvas overlay (the floating chip
    // with a "fullscreen" button in the top-right of each chart). Safari
    // treats RAF-driven canvases as video-like and offers media controls;
    // these attributes opt out where Safari respects them.
    container.querySelectorAll('canvas').forEach((c) => {
      c.setAttribute('disablepictureinpicture', '');
      (c as HTMLCanvasElement & { disablePictureInPicture?: boolean }).disablePictureInPicture = true;
    });

    const ro = new ResizeObserver(() => {
      plot?.setSize({ width: container.clientWidth, height: container.clientHeight });
    });
    ro.observe(container);

    // 20 fps refresh is plenty for spectrum display
    let last = 0;
    const loop = (t: number) => {
      frame = requestAnimationFrame(loop);
      if (t - last < 50) return;
      last = t;
      if (!plot) return;
      plot.setData(buildData(), false);
      if (!autoScale) plot.setScale('y', { min: yMin, max: yMax });
    };
    frame = requestAnimationFrame(loop);

    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  });

  onDestroy(() => { plot?.destroy(); plot = null; });
</script>

<div bind:this={container} class="chart"></div>

<style>
  .chart { width: 100%; height: 100%; min-height: 160px; }
  :global(.uplot, .uplot *) {
    font-family: var(--mono) !important;
    font-size: 10px !important;
  }
</style>
