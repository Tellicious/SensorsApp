<!--
  GPS module page.

  Changes vs. the previous revision (user-reported bugs):
  - Removed the "Satellites" row (the Web API does not expose it).
  - Removed Gain + / − KPIs (rarely useful in practice).
  - Renamed "Bearing" → "Heading" everywhere (matches the underlying
    Geolocation API field name and what the user expected).
  - Autocenter the map on the first fix.
  - Accuracy KPI now shows the CURRENT horizontal accuracy, matching
    the value displayed in the status strip (previously was an average,
    which inevitably diverged from the live value).
  - Reset now also clears lastLat/Lon/Alt/lastT, the in-memory track,
    and the map polyline / marker. Previously these survived a reset
    so the next fix produced a bogus Haversine jump.
  - Map provider configurable: Apple MapKit JS (needs token), CartoDB
    Voyager (free, looks Apple-ish), or OpenStreetMap.

  KPI snapshot ticker: like the Motion page, we also refresh display
  values from a 250 ms interval so the UI stays responsive between
  GPS fixes (Geolocation fires ~1 Hz when moving, less when stationary).
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { settings } from '$lib/stores/settings';
  import { pushGps } from '$lib/stores/session';
  import { createGpsController, haversine, type GpsSample } from '$lib/sensors/gps';
  import KpiCard from '$lib/components/KpiCard.svelte';
  import TimeChart from '$lib/components/TimeChart.svelte';
  import FooterControls from '$lib/components/FooterControls.svelte';
  import { fmtDistance, fmtSpeed, fmtAltitude, unitLabel, convert } from '$lib/util/units';

  const ctrl = createGpsController();
  let running = $state(false);
  let error = $state<string | null>(null);
  let cur = $state<GpsSample | null>(null);

  // ---- Mini-chart buffers ---------------------------------------------
  const CAP = 4096;
  const xs = new Float64Array(CAP);
  const ySpeed = new Float64Array(CAP);
  const yAlt = new Float64Array(CAP);
  const yHeading = new Float64Array(CAP);   // NaN-broken at 0/360 wraps
  let lastHeadingRaw: number | null = null;
  let count = $state(0);
  let t0 = 0;

  // ---- KPI accumulators -----------------------------------------------
  let speedMax = $state(0);
  let speedMin = $state<number>(Infinity);
  let speedSum = 0, speedCount = 0;
  let speedMean = $state(0);
  const speedSamples: number[] = [];
  let speedMedian = $state(0);
  let distance = $state(0);
  let timeMoving = $state(0);
  let lastT = 0;
  let lastLat: number | null = null, lastLon: number | null = null;
  let lastAlt: number | null = null;
  // Circular-mean accumulators for heading
  let headingSinSum = 0, headingCosSum = 0;
  let headingMean = $state(0);

  // ---- Map state -------------------------------------------------------
  let mapEl: HTMLDivElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let map: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let marker: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let track: any = null;
  let trackPts: [number, number][] = [];
  /** Which map provider is actually active (resolved from settings on init). */
  let activeProvider = $state<'apple' | 'carto' | 'osm'>('carto');

  /**
   * Initialize the map with the chosen provider.
   *
   * Provider selection:
   * - 'apple' + token present  → load MapKit JS, init with JWT
   * - 'apple' + no token       → fall back to 'carto' (and warn in console)
   * - 'carto'                  → Leaflet + CartoDB Voyager tiles
   * - 'osm'                    → Leaflet + OpenStreetMap default tiles
   *
   * Apple MapKit JS requires a JWT issued from an Apple Developer
   * account — there is no public/anonymous tier. The user provides the
   * token in Settings → GPS → MapKit JS token. We do not generate or
   * refresh tokens here.
   */
  async function initMap() {
    if (!mapEl) return;
    const provider = $settings.gps.mapProvider;
    const token = $settings.gps.appleMapsToken.trim();

    if (provider === 'apple' && token) {
      try {
        await initAppleMap(token);
        activeProvider = 'apple';
        return;
      } catch (e) {
        console.warn('MapKit JS init failed, falling back to CartoDB:', e);
      }
    } else if (provider === 'apple' && !token) {
      console.warn('Apple Maps selected but no MapKit JS token set — falling back to CartoDB.');
    }

    await initLeafletMap(provider === 'osm' ? 'osm' : 'carto');
    activeProvider = provider === 'osm' ? 'osm' : 'carto';
  }

  async function initAppleMap(token: string) {
    // Lazy-load MapKit JS from Apple's CDN
    if (!('mapkit' in window)) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js';
        s.crossOrigin = 'anonymous';
        s.dataset.callback = 'initMapKit';
        s.dataset.initialToken = token;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('MapKit JS failed to load'));
        document.head.appendChild(s);
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapkit = (window as any).mapkit;
    if (!mapkit) throw new Error('mapkit global missing');
    if (!mapkit.initialized) {
      mapkit.init({
        authorizationCallback: (done: (t: string) => void) => done(token),
        language: 'en'
      });
    }
    map = new mapkit.Map(mapEl, {
      center: new mapkit.Coordinate(45.4642, 9.19),
      cameraDistance: 5000,
      showsCompass: mapkit.FeatureVisibility.Hidden,
      showsScale: mapkit.FeatureVisibility.Hidden
    });
    track = null; // polyline gets created on first sample
    marker = null;
  }

  async function initLeafletMap(kind: 'carto' | 'osm') {
    const L = (await import('leaflet')).default;
    await import('leaflet/dist/leaflet.css');
    map = L.map(mapEl, { attributionControl: false, zoomControl: true }).setView([45.4642, 9.19], 13);
    const tilesUrl = kind === 'carto'
      ? 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'
      : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    L.tileLayer(tilesUrl, {
      maxZoom: 19,
      subdomains: kind === 'carto' ? 'abcd' : 'abc'
    }).addTo(map);
    track = L.polyline([], {
      color: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim(),
      weight: 3
    }).addTo(map);
  }

  onMount(() => { if ($settings.gps.showMap) initMap(); });

  function extendMap(s: GpsSample, firstFix: boolean) {
    if (!map) return;
    trackPts.push([s.lat, s.lon]);

    if (activeProvider === 'apple') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapkit = (window as any).mapkit;
      const coord = new mapkit.Coordinate(s.lat, s.lon);
      if (!track) {
        track = new mapkit.PolylineOverlay(
          trackPts.map(([la, lo]) => new mapkit.Coordinate(la, lo)),
          {
            style: new mapkit.Style({
              strokeColor: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim(),
              lineWidth: 3
            })
          }
        );
        map.addOverlay(track);
      } else {
        track.points = trackPts.map(([la, lo]) => new mapkit.Coordinate(la, lo));
      }
      if (!marker) {
        marker = new mapkit.MarkerAnnotation(coord, {
          color: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim()
        });
        map.addAnnotation(marker);
      } else {
        marker.coordinate = coord;
      }
      if (firstFix) map.setCenterAnimated(coord, true);
    } else {
      track?.setLatLngs(trackPts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const L = (window as any).L;
      if (!marker) {
        marker = L.circleMarker([s.lat, s.lon], {
          radius: 6,
          color: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim(),
          fillColor: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim(),
          fillOpacity: 0.9
        }).addTo(map);
      } else {
        marker.setLatLng([s.lat, s.lon]);
      }
      // Autocenter on first fix — previously was missing, so the user
      // had to manually tap Center every time.
      if (firstFix) map.setView([s.lat, s.lon], 16);
    }
  }

  function onSample(s: GpsSample) {
    const firstFix = trackPts.length === 0;
    if (t0 === 0) t0 = s.t;
    const tSec = (s.t - t0) / 1000;
    cur = s;

    // Append to mini-chart buffers
    if (count < CAP) {
      xs[count] = tSec;
      ySpeed[count] = s.speed ?? 0;
      yAlt[count] = s.alt ?? 0;
      if (s.heading !== null && !isNaN(s.heading)) {
        yHeading[count] = (lastHeadingRaw !== null && Math.abs(s.heading - lastHeadingRaw) > 180)
          ? NaN : s.heading;
        lastHeadingRaw = s.heading;
      } else { yHeading[count] = NaN; }
      count++;
    } else {
      xs.copyWithin(0, 1); ySpeed.copyWithin(0, 1);
      yAlt.copyWithin(0, 1); yHeading.copyWithin(0, 1);
      const i = CAP - 1;
      xs[i] = tSec; ySpeed[i] = s.speed ?? 0; yAlt[i] = s.alt ?? 0;
      if (s.heading !== null && !isNaN(s.heading)) {
        yHeading[i] = (lastHeadingRaw !== null && Math.abs(s.heading - lastHeadingRaw) > 180)
          ? NaN : s.heading;
        lastHeadingRaw = s.heading;
      } else { yHeading[i] = NaN; }
    }

    // KPIs
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
    if (lastLat !== null && lastLon !== null) {
      distance += haversine(lastLat, lastLon, s.lat, s.lon);
    }
    if (lastT !== 0 && (s.speed ?? 0) > $settings.gps.movementThresholdMps) {
      timeMoving += (s.t - lastT);
    }
    if (s.heading !== null && !isNaN(s.heading)) {
      const rad = (s.heading * Math.PI) / 180;
      headingSinSum += Math.sin(rad);
      headingCosSum += Math.cos(rad);
      const meanRad = Math.atan2(headingSinSum, headingCosSum);
      headingMean = ((meanRad * 180) / Math.PI + 360) % 360;
    }
    lastT = s.t; lastLat = s.lat; lastLon = s.lon; lastAlt = s.alt;

    extendMap(s, firstFix);

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
    resetKpi(); // also clears trackPts and map artifacts
    ctrl.start(onSample, (e) => { error = e.message || `Code ${e.code}`; });
    running = true;
  }

  function stop() { ctrl.stop(); running = false; }
  onDestroy(stop);

  function centerOnMe() {
    if (!cur || !map) return;
    if (activeProvider === 'apple') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapkit = (window as any).mapkit;
      map.setCenterAnimated(new mapkit.Coordinate(cur.lat, cur.lon), true);
    } else {
      map.setView([cur.lat, cur.lon], 17);
    }
  }
  function fitTrack() {
    if (!map || trackPts.length < 2) return;
    if (activeProvider === 'apple') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapkit = (window as any).mapkit;
      const lats = trackPts.map(p => p[0]);
      const lons = trackPts.map(p => p[1]);
      const region = new mapkit.CoordinateRegion(
        new mapkit.Coordinate((Math.max(...lats) + Math.min(...lats)) / 2, (Math.max(...lons) + Math.min(...lons)) / 2),
        new mapkit.CoordinateSpan(Math.max(0.001, Math.max(...lats) - Math.min(...lats)) * 1.4,
                                  Math.max(0.001, Math.max(...lons) - Math.min(...lons)) * 1.4)
      );
      map.setRegionAnimated(region, true);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const L = (window as any).L;
      map.fitBounds(L.latLngBounds(trackPts), { padding: [20, 20] });
    }
  }

  /**
   * Reset all KPI accumulators + position cursors + visible track.
   *
   * Previously reset only reset the displayed values but left
   * lastLat/Lon/Alt populated — so the next sample computed a
   * Haversine jump from the pre-reset position and the distance
   * KPI shot up. Now everything is cleared coherently.
   */
  function resetKpi() {
    speedMax = 0; speedMin = Infinity;
    speedSum = 0; speedCount = 0;
    speedMean = 0; speedMedian = 0;
    speedSamples.length = 0;
    distance = 0; timeMoving = 0;
    headingSinSum = 0; headingCosSum = 0; headingMean = 0;
    lastT = 0; lastLat = null; lastLon = null; lastAlt = null;
    lastHeadingRaw = null;
    count = 0; t0 = 0;
    trackPts = [];
    // Clear the visual track polyline
    if (track) {
      if (activeProvider === 'apple') {
        track.points = [];
      } else {
        track.setLatLngs([]);
      }
    }
    // Clear the position marker
    if (marker) {
      if (activeProvider === 'apple' && map) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try { map.removeAnnotation(marker); } catch { /* */ }
      } else if (map) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try { map.removeLayer(marker); } catch { /* */ }
      }
      marker = null;
    }
  }

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

  function fmtDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  // Current-accuracy display (used in both the status strip and the
  // Accuracy KPI so they stay consistent)
  const accCurrent = $derived(cur?.accH ?? null);
</script>

<div class="page">
  <div class="status-strip">
    <span class="dot" class:live={running}></span>
    <span class="subhead">
      {running ? 'Acquiring' : 'Idle'}
      {#if cur} · acc {accCurrent?.toFixed(0) ?? '—'} m{/if}
    </span>
  </div>

  {#if error}<div class="banner danger">{error}</div>{/if}

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
  </section>

  <!-- KPI -->
  <p class="section-header">Trip stats</p>
  <section class="kpi-grid">
    {#if $settings.gps.kpiVisible.distance}
      <KpiCard label="Distance" value={fmtDistance(distance, $settings.global.units)} onReset={resetKpi} big accent />
    {/if}
    {#if $settings.gps.kpiVisible.speedMax}
      <KpiCard label="Speed max" value={convert(speedMax, 'speed', $settings.global.units)} unit={unitLabel('speed', $settings.global.units)} onReset={() => speedMax = 0} />
    {/if}
    {#if $settings.gps.kpiVisible.speedMin}
      <KpiCard label="Speed min" value={isFinite(speedMin) ? convert(speedMin, 'speed', $settings.global.units) : 0} unit={unitLabel('speed', $settings.global.units)} onReset={() => speedMin = Infinity} />
    {/if}
    {#if $settings.gps.kpiVisible.speedAvg}
      <KpiCard label="Speed avg" value={convert(speedMean, 'speed', $settings.global.units)} unit={unitLabel('speed', $settings.global.units)} onReset={resetKpi} />
    {/if}
    {#if $settings.gps.kpiVisible.speedMedian}
      <KpiCard label="Median spd" value={convert(speedMedian, 'speed', $settings.global.units)} unit={unitLabel('speed', $settings.global.units)} onReset={resetKpi} />
    {/if}
    {#if $settings.gps.kpiVisible.timeMoving}
      <KpiCard label="Moving" value={fmtDuration(timeMoving)} onReset={() => timeMoving = 0} />
    {/if}
    {#if $settings.gps.kpiVisible.heading}
      <KpiCard label="Heading avg" value={headingMean} unit="°" onReset={resetKpi} />
    {/if}
    {#if $settings.gps.kpiVisible.accuracy}
      <KpiCard
        label="Accuracy"
        value={accCurrent !== null ? convert(accCurrent, 'altitude', $settings.global.units) : 0}
        unit={unitLabel('altitude', $settings.global.units)}
        onReset={resetKpi}
      />
    {/if}
  </section>

  {#if $settings.gps.showMap}
    <p class="section-header">Map · {activeProvider === 'apple' ? 'Apple Maps' : activeProvider === 'carto' ? 'CartoDB Voyager' : 'OpenStreetMap'}</p>
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

    <p class="section-header">Heading over time</p>
    <section class="card chart-card">
      <div class="chart-host" style="height: 140px">
        <TimeChart
          {xs} ys={[yHeading]}
          seriesDefs={[{ label: 'heading', color: 'var(--series-3)' }]}
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
    -webkit-overflow-scrolling: touch;
  }
  .status-strip { display: flex; align-items: center; gap: 8px; padding: 0 16px 12px; }
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
