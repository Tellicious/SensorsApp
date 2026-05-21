<!--
  GPS module page.

  Displays everything from `navigator.geolocation.watchPosition`:
  - A numeric panel (lat/lon/alt/heading/speed/accuracy)
  - A Leaflet map with the current position marker and the session track
  - Mini time-series for speed and altitude
  - KPIs: distance (Haversine), speed stats, elevation gain, time moving,
    bearing circular mean, accuracy average

  Leaflet and its CSS are dynamically imported so they're not in the
  initial bundle — only this page pays for them.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { settings } from '$lib/stores/settings';
  import { pushGps, sessionState } from '$lib/stores/session';
  import { createGpsController, haversine, type GpsSample } from '$lib/sensors/gps';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import TimeChart from '$lib/components/TimeChart.svelte';
  import FooterControls from '$lib/components/FooterControls.svelte';
  import { fmtDistance, fmtSpeed, fmtAltitude, unitLabel, convert } from '$lib/util/units';

  const ctrl = createGpsController();
  let running = $state(false);
  let error = $state<string | null>(null);
  let cur = $state<GpsSample | null>(null);

  // ---- Buffers for mini-charts ----------------------------------------
  const CAP = 4096;
  const xs = new Float64Array(CAP);
  const ySpeed = new Float64Array(CAP);
  const yAlt = new Float64Array(CAP);
  // Bearing — heading values, NaN-broken across 0/360 wraps so uPlot
  // doesn't draw a vertical line every time the compass crosses north.
  const yBearing = new Float64Array(CAP);
  let lastBearingRaw: number | null = null;
  let count = $state(0);
  let t0 = 0;

  // ---- KPI state -------------------------------------------------------
  let speedMax = $state(0);
  let speedMin = $state(Infinity);
  let speedSum = 0, speedCount = 0;
  let speedMean = $state(0);
  const speedSamples: number[] = [];
  let speedMedian = $state(0);
  let distance = $state(0);        // meters
  let gainPos = $state(0);
  let gainNeg = $state(0);
  let timeMoving = $state(0);
  let lastT = 0;
  let lastLat: number | null = null, lastLon: number | null = null;
  let lastAlt: number | null = null;
  // Circular-mean accumulators for bearing
  let bearingSinSum = 0, bearingCosSum = 0;
  let bearingMean = $state(0);
  let accSum = 0, accCount = 0;
  let accMean = $state(0);

  // ---- Map -------------------------------------------------------------
  let mapEl: HTMLDivElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let map: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let marker: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let track: any = null;
  let trackPts: [number, number][] = [];

  /**
   * Lazy-load Leaflet (and its CSS) and instantiate the map.
   * Centered on Milan by default — replaced on first fix.
   */
  async function initMap() {
    if (!mapEl) return;
    const L = (await import('leaflet')).default;
    await import('leaflet/dist/leaflet.css');
    map = L.map(mapEl, { attributionControl: false, zoomControl: true }).setView([45.4642, 9.19], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    track = L.polyline([], { color: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim(), weight: 3 }).addTo(map);
  }

  onMount(() => { if ($settings.gps.showMap) initMap(); });

  /**
   * Process a geolocation sample: append to buffers, update KPIs,
   * extend the map track, and stream to the logger.
   */
  function onSample(s: GpsSample) {
    if (t0 === 0) t0 = s.t;
    const tSec = (s.t - t0) / 1000;
    cur = s;

    if (count < CAP) {
      xs[count] = tSec;
      ySpeed[count] = s.speed ?? 0;
      yAlt[count] = s.alt ?? 0;
      // Bearing: insert NaN when the value wraps across 0/360 so uPlot
      // breaks the line instead of drawing a vertical spike from 359 → 1.
      if (s.heading !== null && !isNaN(s.heading)) {
        if (lastBearingRaw !== null && Math.abs(s.heading - lastBearingRaw) > 180) {
          yBearing[count] = NaN;
        } else {
          yBearing[count] = s.heading;
        }
        lastBearingRaw = s.heading;
      } else {
        yBearing[count] = NaN;
      }
      count++;
    } else {
      xs.copyWithin(0, 1); ySpeed.copyWithin(0, 1); yAlt.copyWithin(0, 1); yBearing.copyWithin(0, 1);
      const i = CAP - 1;
      xs[i] = tSec; ySpeed[i] = s.speed ?? 0; yAlt[i] = s.alt ?? 0;
      if (s.heading !== null && !isNaN(s.heading)) {
        if (lastBearingRaw !== null && Math.abs(s.heading - lastBearingRaw) > 180) {
          yBearing[i] = NaN;
        } else {
          yBearing[i] = s.heading;
        }
        lastBearingRaw = s.heading;
      } else {
        yBearing[i] = NaN;
      }
    }

    // Speed stats
    if (s.speed !== null) {
      speedMax = Math.max(speedMax, s.speed);
      if (s.speed < speedMin) speedMin = s.speed;
      speedSum += s.speed; speedCount++;
      speedMean = speedSum / speedCount;
      speedSamples.push(s.speed);
      if (speedSamples.length > 1000) speedSamples.shift();
      const sorted = [...speedSamples].sort((a, b) => a - b);
      speedMedian = sorted[Math.floor(sorted.length / 2)];
    }
    // Distance (Haversine between consecutive fixes)
    if (lastLat !== null && lastLon !== null) distance += haversine(lastLat, lastLon, s.lat, s.lon);
    // Elevation gain / loss
    if (lastAlt !== null && s.alt !== null) {
      const dh = s.alt - lastAlt;
      if (dh > 0) gainPos += dh; else gainNeg -= dh;
    }
    // Time moving — accumulate only when above threshold
    if (lastT !== 0 && (s.speed ?? 0) > $settings.gps.movementThresholdMps) {
      timeMoving += (s.t - lastT);
    }
    // Bearing circular mean
    if (s.heading !== null && !isNaN(s.heading)) {
      const rad = (s.heading * Math.PI) / 180;
      bearingSinSum += Math.sin(rad);
      bearingCosSum += Math.cos(rad);
      const meanRad = Math.atan2(bearingSinSum, bearingCosSum);
      bearingMean = ((meanRad * 180) / Math.PI + 360) % 360;
    }
    if (s.accH !== null) { accSum += s.accH; accCount++; accMean = accSum / accCount; }
    lastT = s.t; lastLat = s.lat; lastLon = s.lon; lastAlt = s.alt;

    // Map: extend track polyline + move marker
    if (map) {
      trackPts.push([s.lat, s.lon]);
      track.setLatLngs(trackPts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const L = (window as any).L;
      if (!marker) {
        // circleMarker — no PNG icon needed, works offline
        marker = L.circleMarker([s.lat, s.lon], {
          radius: 6,
          color: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim(),
          fillColor: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim(),
          fillOpacity: 0.9
        }).addTo(map);
      } else {
        marker.setLatLng([s.lat, s.lon]);
      }
    }

    pushGps({
      t: Math.floor(s.t - t0),
      lat: s.lat, lon: s.lon, alt: s.alt,
      accH: s.accH, accV: s.accV, heading: s.heading, speed: s.speed
    });
  }

  function start() {
    if (running) return;
    if (!map && $settings.gps.showMap) initMap();
    error = null;
    count = 0; t0 = 0; trackPts = [];
    if (track) track.setLatLngs([]);
    speedMax = 0; speedMin = Infinity; speedSum = 0; speedCount = 0; speedMean = 0; speedMedian = 0;
    speedSamples.length = 0;
    distance = 0; gainPos = 0; gainNeg = 0; timeMoving = 0;
    bearingSinSum = 0; bearingCosSum = 0; bearingMean = 0;
    lastBearingRaw = null;
    accSum = 0; accCount = 0; accMean = 0;
    lastT = 0; lastLat = null; lastLon = null; lastAlt = null;
    ctrl.start(onSample, (e) => { error = e.message || `Code ${e.code}`; });
    running = true;
  }

  function stop() { ctrl.stop(); running = false; }
  onDestroy(stop);

  /** Recenter the map on the latest fix. */
  function centerOnMe() {
    if (cur && map) map.setView([cur.lat, cur.lon], 17);
  }
  /** Zoom map so the entire recorded track fits the viewport. */
  function fitTrack() {
    if (map && trackPts.length > 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const L = (window as any).L;
      map.fitBounds(L.latLngBounds(trackPts), { padding: [20, 20] });
    }
  }

  function resetKpi() {
    speedMax = 0; speedMin = Infinity; speedSum = 0; speedCount = 0; speedMean = 0; speedMedian = 0;
    speedSamples.length = 0;
    distance = 0; gainPos = 0; gainNeg = 0; timeMoving = 0;
    bearingSinSum = 0; bearingCosSum = 0; bearingMean = 0;
    accSum = 0; accCount = 0; accMean = 0;
  }

  /** Format a coordinate either as decimal degrees or DMS depending on settings. */
  function fmtCoord(v: number | null, isLat: boolean): string {
    if (v === null) return '—';
    if ($settings.gps.coordFormat === 'decimal') return v.toFixed(6);
    const a = Math.abs(v);
    const d = Math.floor(a);
    const mFloat = (a - d) * 60;
    const m = Math.floor(mFloat);
    const sec = (mFloat - m) * 60;
    const hem = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
    return `${d}° ${m}' ${sec.toFixed(2)}" ${hem}`;
  }

  /** Human-friendly duration formatter (1h 23m / 4m 12s / 12s). */
  function fmtDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }
</script>

<div class="page">
  <div class="status-strip">
    <span class="dot" class:live={running}></span>
    <span class="subhead">
      {running ? 'Acquiring' : 'Idle'}
      {#if cur} · acc {cur.accH?.toFixed(0) ?? '—'} m{/if}
    </span>
  </div>

  {#if error}<div class="banner danger">{error}</div>{/if}

  <!-- COORDINATES -->
  <p class="section-header">Position</p>
  <section class="list-group">
    <div class="list-row">
      <span class="list-row-label footnote">Latitude</span>
      <span class="value-mono">{fmtCoord(cur?.lat ?? null, true)}</span>
    </div>
    <div class="list-row">
      <span class="list-row-label footnote">Longitude</span>
      <span class="value-mono">{fmtCoord(cur?.lon ?? null, false)}</span>
    </div>
    <div class="list-row">
      <span class="list-row-label footnote">Altitude</span>
      <span class="value-mono">{fmtAltitude(cur?.alt ?? null, $settings.global.units)}</span>
    </div>
    <div class="list-row">
      <span class="list-row-label footnote">Heading</span>
      <span class="value-mono">{cur?.heading?.toFixed(0) ?? '—'} °</span>
    </div>
    <div class="list-row">
      <span class="list-row-label footnote">Speed</span>
      <span class="value-mono">
        {fmtSpeed(cur?.speed ?? null, $settings.global.units, $settings.global.units === 'si')}
      </span>
    </div>
    <div class="list-row">
      <span class="list-row-label footnote">Accuracy (V)</span>
      <span class="value-mono">{fmtAltitude(cur?.accV ?? null, $settings.global.units)}</span>
    </div>
    <div class="list-row">
      <span class="list-row-label footnote">Satellites</span>
      <span class="value-mono footnote">N/A · not exposed by Web API</span>
    </div>
  </section>

  <!-- KPI -->
  <p class="section-header">Trip stats</p>
  <section class="kpi-grid">
    <KpiCard
      label="Distance"
      value={fmtDistance(distance, $settings.global.units)}
      onReset={resetKpi}
      big accent
    />
    <KpiCard
      label="Speed max"
      value={convert(speedMax, 'speed', $settings.global.units)}
      unit={unitLabel('speed', $settings.global.units)}
      onReset={() => speedMax = 0}
    />
    <KpiCard
      label="Speed min"
      value={isFinite(speedMin) ? convert(speedMin, 'speed', $settings.global.units) : 0}
      unit={unitLabel('speed', $settings.global.units)}
      onReset={() => speedMin = Infinity}
    />
    <KpiCard
      label="Speed avg"
      value={convert(speedMean, 'speed', $settings.global.units)}
      unit={unitLabel('speed', $settings.global.units)}
      onReset={resetKpi}
    />
    <KpiCard
      label="Median spd"
      value={convert(speedMedian, 'speed', $settings.global.units)}
      unit={unitLabel('speed', $settings.global.units)}
      onReset={resetKpi}
    />
    <KpiCard
      label="Gain +"
      value={convert(gainPos, 'altitude', $settings.global.units)}
      unit={unitLabel('altitude', $settings.global.units)}
      onReset={() => gainPos = 0}
    />
    <KpiCard
      label="Gain −"
      value={convert(gainNeg, 'altitude', $settings.global.units)}
      unit={unitLabel('altitude', $settings.global.units)}
      onReset={() => gainNeg = 0}
    />
    <KpiCard label="Moving" value={fmtDuration(timeMoving)} onReset={() => timeMoving = 0} />
    <KpiCard label="Bearing avg" value={bearingMean} unit="°" onReset={resetKpi} />
    <KpiCard
      label="Acc avg"
      value={convert(accMean, 'altitude', $settings.global.units)}
      unit={unitLabel('altitude', $settings.global.units)}
      onReset={resetKpi}
    />
  </section>

  <!-- MAP -->
  {#if $settings.gps.showMap}
    <p class="section-header">Map</p>
    <section class="card chart-card">
      <div class="card-head">
        <span class="headline">Track</span>
        <span class="spacer"></span>
        <button class="btn-tinted btn-small" onclick={centerOnMe} disabled={!cur}>Center</button>
        <button class="btn-tinted btn-small" onclick={fitTrack} disabled={trackPts.length < 2}>Fit</button>
      </div>
      <div bind:this={mapEl} class="map-host"></div>
    </section>
  {/if}

  <!-- CHARTS -->
  {#if $settings.gps.showTimeCharts}
    <p class="section-header">Speed over time</p>
    <section class="card chart-card">
      <div class="chart-host" style="height: 140px">
        <TimeChart
          {xs} ys={[ySpeed]}
          seriesDefs={[{ label: 'speed', color: 'var(--series-2)' }]}
          {count}
          windowSec={Math.max(60, count > 0 ? xs[count-1] : 60)}
          yLabel="m/s"
        />
      </div>
    </section>

    <p class="section-header">Altitude over time</p>
    <section class="card chart-card">
      <div class="chart-host" style="height: 140px">
        <TimeChart
          {xs} ys={[yAlt]}
          seriesDefs={[{ label: 'alt', color: 'var(--series-1)' }]}
          {count}
          windowSec={Math.max(60, count > 0 ? xs[count-1] : 60)}
          yLabel={unitLabel('altitude', $settings.global.units)}
        />
      </div>
    </section>

    <p class="section-header">Bearing over time</p>
    <section class="card chart-card">
      <div class="chart-host" style="height: 140px">
        <!--
          Bearing wraps across 0/360. We insert NaN at wrap points in the
          buffer (see onSample) so uPlot breaks the line instead of drawing
          a vertical spike from 359° to 1°. Y axis is fixed 0..360.
        -->
        <TimeChart
          {xs} ys={[yBearing]}
          seriesDefs={[{ label: 'bearing', color: 'var(--series-3)' }]}
          {count}
          windowSec={Math.max(60, count > 0 ? xs[count-1] : 60)}
          yMin={0} yMax={360}
          yLabel="°"
        />
      </div>
    </section>
  {/if}
</div>

<FooterControls module="gps" {running} onStart={start} onStop={stop} onResetKpi={resetKpi} />

<style>
  .page {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0 12px;
    background: var(--bg-grouped);
  }
  .status-strip {
    display: flex; align-items: center; gap: 8px;
    padding: 0 16px 12px;
  }
  .banner {
    margin: 8px 16px;
    padding: 12px 16px;
    background: var(--bg-elev);
    border-radius: var(--r-card);
    color: var(--danger);
    font-size: var(--t-footnote);
  }
  .section-header {
    font-size: var(--t-footnote);
    color: var(--fg-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 16px 6px 20px;
    font-weight: 400;
  }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    padding: 0 16px;
  }
  @media (min-width: 480px) {
    .kpi-grid { grid-template-columns: repeat(3, 1fr); }
  }
  .chart-card { margin: 0 16px; overflow: hidden; }
  .card-head {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 14px;
    border-bottom: 0.5px solid var(--separator);
  }
  .chart-host { padding: 8px; }
  .map-host {
    height: 280px;
    background: var(--bg-elev-2);
  }
  :global(.leaflet-container) {
    background: var(--bg-elev-2) !important;
    font-family: var(--sans) !important;
  }
</style>
