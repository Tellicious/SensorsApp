/**
 * GPS sensor wrapper.
 *
 * Thin abstraction over `navigator.geolocation.watchPosition` with
 * high-accuracy mode and zero-cache (every emission is a fresh fix).
 * Returned samples follow our internal shape (with `t` as `performance.now()`
 * ms so all sensors share a common timeline).
 *
 * Also exports the Haversine great-circle distance helper used by the
 * Trip-Stats KPIs on the GPS page.
 */

/** One geolocation fix. Most fields are null on platforms that don't expose them. */
export interface GpsSample {
  /** Timestamp from `performance.now()` (ms). */
  t: number;
  /** Latitude in decimal degrees, north positive. */
  lat: number;
  /** Longitude in decimal degrees, east positive. */
  lon: number;
  /** Altitude above WGS84 ellipsoid, meters. Null if unknown. */
  alt: number | null;
  /** Horizontal accuracy (1σ) in meters. */
  accH: number | null;
  /** Vertical accuracy (1σ) in meters. */
  accV: number | null;
  /** Heading in degrees, 0 = north, increasing clockwise. */
  heading: number | null;
  /** Ground speed in meters per second. */
  speed: number | null;
}

export type GpsCallback = (s: GpsSample) => void;
export type GpsErrorCallback = (e: GeolocationPositionError) => void;

export interface GpsController {
  start(cb: GpsCallback, onError?: GpsErrorCallback): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * Build a fresh GPS controller. `start()` begins receiving fixes via
 * watchPosition; `stop()` clears the watch.
 */
export function createGpsController(): GpsController {
  let watchId: number | null = null;
  let running = false;

  return {
    start(cb, onError) {
      if (!('geolocation' in navigator)) {
        onError?.({ code: 2, message: 'Geolocation not supported' } as GeolocationPositionError);
        return;
      }
      if (running) return;
      // enableHighAccuracy → use GPS chip rather than wifi/IP geolocation.
      // maximumAge: 0 → never return a cached fix; we always want fresh.
      // timeout: 10s → fire onError if no fix in that window (e.g. indoors).
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          cb({
            t: performance.now(),
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            alt: pos.coords.altitude,
            accH: pos.coords.accuracy,
            accV: pos.coords.altitudeAccuracy,
            heading: pos.coords.heading,
            speed: pos.coords.speed
          });
        },
        (err) => onError?.(err),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 }
      );
      running = true;
    },
    stop() {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      running = false;
    },
    get running() { return running; }
  };
}

/**
 * Great-circle distance between two lat/lon points, in meters.
 *
 * Uses the Haversine formula. Accurate to a fraction of a percent at any
 * realistic terrestrial distance — well below the GPS noise floor itself.
 *
 *   a = sin²(Δφ/2) + cos(φ₁)·cos(φ₂)·sin²(Δλ/2)
 *   d = 2R·asin(√a)
 *
 * R = 6 371 000 m (mean Earth radius).
 */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
