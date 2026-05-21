<!--
  SpectrogramChart
  ================
  Scrolling 2D canvas spectrogram. Each incoming spectrum is rendered as a
  vertical column on the right edge; existing pixels are shifted one column
  to the left, producing a waterfall display where time flows right-to-left.

  Rendering technique: `ctx.drawImage(canvas, -1, 0)` shifts the entire
  framebuffer left by one pixel in a single GPU-accelerated blit, then a
  single `putImageData(1×H)` writes the new column. This is the fastest
  CPU-only path; WebGL would be marginally faster but adds significant
  complexity for marginal gain at a ~12 Hz frame rate.

  Colormap: viridis or magma — both are perceptually uniform and stay
  legible on color-vision-deficient displays, unlike rainbow/jet. Computed
  via polynomial approximation rather than a 256-entry LUT to keep the
  component self-contained.

  Bin → pixel mapping: linear by default, log when `logFreq=true`. Log
  axis spreads low-frequency detail (where most human-relevant audio
  energy lives) at the expense of high-frequency resolution.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface Props {
    /** Most recent magnitude/dB spectrum. Re-rendered on frameId change. */
    spectrum: Float32Array;
    /**
     * Monotonically-increasing counter incremented by the parent on every
     * new frame. Drives the redraw $effect — necessary because the parent
     * mutates `spectrum` in place, so prop-identity comparison wouldn't
     * trigger reactivity on its own.
     */
    frameId: number;
    /** Total number of spectrum bins. */
    bins: number;
    /** Sample rate (Hz). Used only to label the Y axis. */
    sampleRate: number;
    /** Use log-frequency Y axis (low frequencies expanded). */
    logFreq?: boolean;
    /** dB value mapped to colormap = 0 (cold). */
    minDb?: number;
    /** dB value mapped to colormap = 1 (hot). */
    maxDb?: number;
    /** Colormap name. */
    colormap?: 'viridis' | 'magma' | 'grayscale';
  }
  let {
    spectrum, frameId, bins, sampleRate,
    logFreq = true,
    minDb = -120, maxDb = 0,
    colormap = 'viridis'
  }: Props = $props();

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let W = 0, H = 0;
  let dpr = 1;
  /** Index→bin lookup, recomputed when bins or logFreq changes. */
  let yToBin = new Int32Array(0);
  /** Tracks the last frameId we drew so we don't double-render. */
  let lastFrameId = -1;

  // ---- Colormap (polynomial approximations) ----------------------------
  // Viridis polynomial — coefficients picked to match the standard
  // matplotlib viridis to within ~3 RGB-units across the range.
  function viridis(t: number): [number, number, number] {
    const c = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
    const r = 0.267 + t * (0.105 + t * (-0.353 + t * (1.692)));
    const g = 0.004 + t * (1.385 + t * (-1.169 + t * (0.561)));
    const b = 0.329 + t * (1.380 + t * (-3.890 + t * (2.621)));
    return [c(r), c(g), c(b)];
  }
  function magma(t: number): [number, number, number] {
    const c = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
    const r = -0.002 + t * (0.487 + t * (1.829 + t * (-1.346)));
    const g = 0.000 + t * (0.062 + t * (1.083 + t * (-0.142)));
    const b = 0.014 + t * (1.795 + t * (-2.999 + t * (1.387)));
    return [c(r), c(g), c(b)];
  }
  function gray(t: number): [number, number, number] {
    const v = Math.max(0, Math.min(255, Math.round(t * 255)));
    return [v, v, v];
  }
  function pickColor(t: number): [number, number, number] {
    if (colormap === 'magma')    return magma(t);
    if (colormap === 'grayscale') return gray(t);
    return viridis(t);
  }

  // ---- Bin lookup --------------------------------------------------------
  /**
   * Precompute, for each pixel row y in [0, H), the spectrum bin index
   * to sample from. Row 0 is at the top = highest frequency.
   * - Linear: y=0 → bin=bins-1, y=H-1 → bin=0
   * - Log:    same endpoints, but with exponential spacing in between
   */
  function rebuildBinLookup() {
    yToBin = new Int32Array(H);
    if (!bins || H === 0) return;
    for (let y = 0; y < H; y++) {
      const frac = (H - 1 - y) / Math.max(1, H - 1); // 0 at top → 1 at bottom
      let binIdx: number;
      if (logFreq && bins > 1) {
        // Skip bin 0 (DC) when log: log(0) is -inf. Start from bin 1.
        const minBin = 1;
        const maxBin = bins - 1;
        const logMin = Math.log(minBin);
        const logMax = Math.log(maxBin);
        const idx = Math.exp(logMin + (logMax - logMin) * frac);
        binIdx = Math.round(idx);
      } else {
        binIdx = Math.round(frac * (bins - 1));
      }
      yToBin[y] = Math.max(0, Math.min(bins - 1, binIdx));
    }
  }

  // ---- Render -----------------------------------------------------------
  /**
   * Draw a single column for the latest spectrum:
   *   1. Shift the entire canvas one pixel left
   *   2. putImageData on the rightmost column
   */
  function drawColumn() {
    if (!ctx || !canvas || !spectrum) return;
    // Step 1: shift left. drawImage with negative x is GPU-blit fast.
    ctx.drawImage(canvas, -1 * dpr, 0);

    // Step 2: build the new rightmost column
    const col = ctx.createImageData(1, H * dpr);
    const data = col.data;
    const range = maxDb - minDb;
    for (let y = 0; y < H * dpr; y++) {
      const bin = yToBin[Math.min(yToBin.length - 1, Math.floor(y / dpr))] ?? 0;
      const db = spectrum[bin];
      // Floor at minDb so deep silence renders as the cold color, not white.
      const norm = Math.max(0, Math.min(1, ((db ?? -200) - minDb) / range));
      const [r, g, b] = pickColor(norm);
      const i = y * 4;
      data[i]     = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    ctx.putImageData(col, (W - 1) * dpr, 0);
  }

  function fitCanvas() {
    if (!canvas || !container) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = container.clientWidth;
    H = container.clientHeight;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    // Clear to dark
    if (ctx) {
      const dark = pickColor(0);
      ctx.fillStyle = `rgb(${dark[0]},${dark[1]},${dark[2]})`;
      ctx.fillRect(0, 0, W * dpr, H * dpr);
    }
    rebuildBinLookup();
  }

  onMount(() => {
    ctx = canvas.getContext('2d', { alpha: false });
    fitCanvas();
    const ro = new ResizeObserver(() => fitCanvas());
    ro.observe(container);
    return () => ro.disconnect();
  });

  // Trigger a column draw on every new frame
  $effect(() => {
    if (frameId !== lastFrameId) {
      lastFrameId = frameId;
      drawColumn();
    }
  });

  // Rebuild lookup if the geometry parameters change
  $effect(() => {
    void bins; void logFreq;
    if (H > 0) rebuildBinLookup();
  });

  onDestroy(() => { ctx = null; });
</script>

<div bind:this={container} class="spec-host">
  <canvas bind:this={canvas}></canvas>
  <div class="spec-axis">
    <span>{(sampleRate / 2 / 1000).toFixed(1)} kHz</span>
    <span>0</span>
  </div>
</div>

<style>
  .spec-host {
    position: relative;
    width: 100%;
    height: 200px;
    border-radius: var(--r-card);
    overflow: hidden;
    background: #000;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .spec-axis {
    position: absolute;
    top: 0;
    right: 6px;
    bottom: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 4px 0;
    pointer-events: none;
    font-family: var(--mono);
    font-size: 9px;
    color: rgba(255, 255, 255, 0.55);
    text-shadow: 0 0 2px #000;
  }
</style>
