<!--
  Full-screen chart overlay with touch-driven pan and zoom.

  Mounts an independent uPlot instance that reads from the same Float64
  buffer references as the inline chart, so live data continues to
  stream while in full-screen.

  Touch interactions:
  - One-finger drag      → pan X axis
  - Two-finger pinch     → zoom X axis (anchored at midpoint between fingers)
  - Double-tap           → reset to live auto-follow
  - "Live" pill in the corner indicates whether the view is following
    the head of the data (true) or has been manually panned/zoomed and
    is therefore frozen on a window (false).

  Pinch on Y is intentionally NOT implemented — it would tangle with
  iOS Safari's own page-pinch gesture and most charts are X-axis-bound
  by user intent (zoom in on time / frequency).
-->
<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';

  interface SeriesDef { label: string; color: string; }

  interface Props {
    kind: 'time' | 'fft';
    title?: string;
    // Time-chart fields
    xs?: Float64Array;
    ys?: Float64Array[];
    count?: number;
    windowSec?: number;
    xLabel?: string;
    // FFT-chart fields
    freqs?: Float32Array;
    spectra?: Float32Array[];
    logX?: boolean;
    logY?: boolean;
    autoScale?: boolean;
    // Shared
    seriesDefs: SeriesDef[];
    yMin?: number;
    yMax?: number;
    yLabel?: string;
    onClose: () => void;
  }
  let {
    kind,
    title = '',
    xs, ys, count, windowSec, xLabel = 's',
    freqs, spectra, logX, logY, autoScale, seriesDefs,
    yMin, yMax, yLabel = '',
    onClose
  }: Props = $props();

  let host: HTMLDivElement;
  let plot: uPlot | null = null;
  let rafId = 0;
  let live = $state(true);

  // Resolve CSS color tokens to canvas-friendly strings
  function resolveColor(c: string): string {
    if (!c.startsWith('var(')) return c;
    const name = c.slice(4, -1).trim();
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  function buildSeries(): uPlot.Series[] {
    const arr: uPlot.Series[] = [{}]; // X
    for (const def of seriesDefs) {
      arr.push({
        label: def.label,
        stroke: resolveColor(def.color),
        width: 1.5,
        spanGaps: false
      });
    }
    return arr;
  }

  function buildData(): uPlot.AlignedData {
    if (kind === 'time') {
      const n = count ?? xs?.length ?? 0;
      const xArr = xs?.subarray(0, n) ?? new Float64Array(0);
      const data: uPlot.AlignedData = [Array.from(xArr)];
      for (const y of ys ?? []) data.push(Array.from(y.subarray(0, n)) as number[]);
      return data;
    } else {
      const f = freqs ?? new Float32Array(0);
      const data: uPlot.AlignedData = [Array.from(f) as number[]];
      for (const s of spectra ?? []) data.push(Array.from(s) as number[]);
      return data;
    }
  }

  function mountPlot() {
    if (!host) return;
    const tickColor    = getComputedStyle(document.documentElement).getPropertyValue('--separator').trim();
    const labelColor   = getComputedStyle(document.documentElement).getPropertyValue('--fg-secondary').trim();
    const bg           = getComputedStyle(document.documentElement).getPropertyValue('--bg-elev').trim();

    const opts: uPlot.Options = {
      width: host.clientWidth,
      height: host.clientHeight,
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { show: false } },
      scales: {
        x: { time: false, distr: (kind === 'fft' && logX) ? 3 : 1 },
        y: {
          auto: kind === 'fft' ? (autoScale ?? true) : (yMin === undefined && yMax === undefined),
          range: (yMin !== undefined && yMax !== undefined) ? [yMin, yMax] : undefined,
          distr: (kind === 'fft' && logY) ? 3 : 1
        }
      },
      axes: [
        {
          stroke: labelColor, grid: { stroke: tickColor, width: 0.5 },
          ticks: { stroke: tickColor },
          label: kind === 'time' ? xLabel : 'Hz',
          labelSize: 18
        },
        {
          stroke: labelColor, grid: { stroke: tickColor, width: 0.5 },
          ticks: { stroke: tickColor },
          label: yLabel, labelSize: 18
        }
      ],
      series: buildSeries(),
      hooks: {
        ready: [(u) => { u.root.style.background = bg; }]
      }
    };
    plot = new uPlot(opts, buildData(), host);
    // Auto-window X for live time charts (latest windowSec)
    if (kind === 'time' && live) {
      autoFollow();
    }
  }

  function autoFollow() {
    if (!plot || kind !== 'time' || !live) return;
    const n = count ?? 0;
    if (n < 2) return;
    const x = xs!;
    const tEnd = x[n - 1];
    const w = windowSec ?? 10;
    plot.setScale('x', { min: Math.max(0, tEnd - w), max: tEnd });
  }

  function refresh() {
    if (!plot) return;
    plot.setData(buildData(), false);
    autoFollow();
    rafId = requestAnimationFrame(refresh);
  }

  // --- Touch handlers ---------------------------------------------------
  let touchStartDist = 0;
  let touchStartX = 0;
  let touchStartScale = { min: 0, max: 1 };
  let lastTapT = 0;

  function onTouchStart(e: TouchEvent) {
    if (!plot) return;
    if (e.touches.length === 2) {
      // Pinch
      const t1 = e.touches[0], t2 = e.touches[1];
      touchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      touchStartScale = {
        min: plot.scales.x.min ?? 0,
        max: plot.scales.x.max ?? 1
      };
      live = false;
    } else if (e.touches.length === 1) {
      const now = performance.now();
      if (now - lastTapT < 300) {
        // Double-tap → reset to live
        live = true;
        autoFollow();
        lastTapT = 0;
        return;
      }
      lastTapT = now;
      touchStartX = e.touches[0].clientX;
      touchStartScale = {
        min: plot.scales.x.min ?? 0,
        max: plot.scales.x.max ?? 1
      };
      live = false;
    }
  }

  function onTouchMove(e: TouchEvent) {
    if (!plot) return;
    e.preventDefault();
    if (e.touches.length === 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      if (touchStartDist === 0) return;
      const scaleFactor = touchStartDist / dist;
      const range = touchStartScale.max - touchStartScale.min;
      const newRange = Math.max(1e-9, range * scaleFactor);
      const center = (touchStartScale.max + touchStartScale.min) / 2;
      plot.setScale('x', {
        min: center - newRange / 2,
        max: center + newRange / 2
      });
    } else if (e.touches.length === 1) {
      const dx = e.touches[0].clientX - touchStartX;
      const range = touchStartScale.max - touchStartScale.min;
      const w = plot.bbox.width || host.clientWidth || 1;
      const dataDx = -dx * range / w;
      plot.setScale('x', {
        min: touchStartScale.min + dataDx,
        max: touchStartScale.max + dataDx
      });
    }
  }

  function onTouchEnd() { touchStartDist = 0; }

  function resetZoom() {
    live = true;
    if (kind === 'time') {
      autoFollow();
    } else if (plot && freqs && freqs.length > 1) {
      plot.setScale('x', { min: freqs[0], max: freqs[freqs.length - 1] });
    }
  }

  function onResize() {
    if (!plot || !host) return;
    plot.setSize({ width: host.clientWidth, height: host.clientHeight });
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }

  onMount(() => {
    untrack(() => mountPlot());
    rafId = requestAnimationFrame(refresh);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);
    // Lock page scroll while overlay is open
    document.body.style.overflow = 'hidden';
  });
  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    plot?.destroy();
    plot = null;
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
  });
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label="Full-screen chart">
  <header class="fs-head">
    <span class="fs-title">{title}</span>
    <span class="spacer"></span>
    <span class="live-pill" class:on={live}>{live ? '● LIVE' : 'PAUSED'}</span>
    <button class="fs-btn" onclick={resetZoom} aria-label="Reset zoom">Reset</button>
    <button class="fs-btn close-btn" onclick={onClose} aria-label="Close">✕</button>
  </header>
  <div
    class="fs-host"
    bind:this={host}
    ontouchstart={onTouchStart}
    ontouchmove={onTouchMove}
    ontouchend={onTouchEnd}
    ontouchcancel={onTouchEnd}
  ></div>
  <footer class="fs-hint">
    Pinch to zoom · drag to pan · double-tap for live
  </footer>
</div>

<style>
  .overlay {
    position: fixed; inset: 0;
    z-index: 200;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    padding-top: var(--safe-top);
    padding-bottom: var(--safe-bottom);
  }
  .fs-head {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    border-bottom: 0.5px solid var(--separator);
    min-height: 48px;
  }
  .fs-title {
    font-size: var(--t-headline);
    font-weight: 600;
    color: var(--fg);
  }
  .spacer { flex: 1; }
  .live-pill {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 4px 8px;
    border-radius: var(--r-pill);
    background: var(--fill-tertiary);
    color: var(--fg-tertiary);
  }
  .live-pill.on {
    background: var(--success-dim, rgba(52, 199, 89, 0.2));
    color: var(--success, #34c759);
  }
  .fs-btn {
    min-height: 36px;
    padding: 6px 12px;
    background: var(--fill-tertiary);
    color: var(--fg);
    border: none;
    border-radius: var(--r-control);
    font-size: var(--t-body);
    font-weight: 500;
    cursor: pointer;
  }
  .close-btn {
    width: 36px; height: 36px;
    padding: 0;
    border-radius: 50%;
    background: var(--fill-tertiary);
  }
  .fs-host {
    flex: 1;
    width: 100%;
    overflow: hidden;
    touch-action: none;
  }
  .fs-hint {
    text-align: center;
    color: var(--fg-tertiary);
    font-size: var(--t-footnote);
    padding: 6px 16px 12px;
  }
</style>
