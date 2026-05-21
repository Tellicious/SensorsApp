/**
 * Unit-system aware formatters.
 *
 * Driven by `settings.global.units` ('si' | 'imperial'). Every helper
 * takes the raw SI value (meters, m/s, m/s²) plus the active unit system
 * and returns a string with the right unit suffix.
 *
 * Conversions used (NIST exact factors where defined):
 *
 *   1 m   = 3.280839895  ft
 *   1 m/s = 2.236936292  mph
 *   1 m   = 6.213711922e-4 mi
 */

export type UnitSystem = 'si' | 'imperial';

const M_TO_FT  = 3.280839895;
const MPS_TO_MPH = 2.236936292;
const M_TO_MI  = 0.0006213711922;

/**
 * Format a distance in meters. Picks the most readable unit
 * (m / km in SI, ft / mi in Imperial) based on magnitude.
 */
export function fmtDistance(m: number | null | undefined, units: UnitSystem): string {
  if (m === null || m === undefined || !isFinite(m)) return '—';
  if (units === 'imperial') {
    const ft = m * M_TO_FT;
    if (Math.abs(ft) < 5280) return `${ft.toFixed(0)} ft`;
    return `${(m * M_TO_MI).toFixed(2)} mi`;
  }
  if (Math.abs(m) < 1000) return `${m.toFixed(m < 10 ? 2 : m < 100 ? 1 : 0)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

/**
 * Format a speed in m/s. Imperial → mph; SI → m/s with km/h companion.
 * The `companion` flag adds the "/ NN km/h" part for SI.
 */
export function fmtSpeed(mps: number | null | undefined, units: UnitSystem, companion = false): string {
  if (mps === null || mps === undefined || !isFinite(mps)) return '—';
  if (units === 'imperial') return `${(mps * MPS_TO_MPH).toFixed(1)} mph`;
  if (companion) return `${mps.toFixed(2)} m/s · ${(mps * 3.6).toFixed(1)} km/h`;
  return `${mps.toFixed(2)} m/s`;
}

/** Format an altitude in meters. */
export function fmtAltitude(m: number | null | undefined, units: UnitSystem): string {
  if (m === null || m === undefined || !isFinite(m)) return '—';
  if (units === 'imperial') return `${(m * M_TO_FT).toFixed(1)} ft`;
  return `${m.toFixed(1)} m`;
}

/** Unit-label suffix only — useful for KpiCard which displays value + unit separately. */
export function unitLabel(kind: 'distance-short' | 'distance' | 'speed' | 'altitude', units: UnitSystem): string {
  if (kind === 'distance-short') return units === 'imperial' ? 'ft' : 'm';
  if (kind === 'distance')       return units === 'imperial' ? 'mi' : 'km';
  if (kind === 'speed')          return units === 'imperial' ? 'mph' : 'm/s';
  if (kind === 'altitude')       return units === 'imperial' ? 'ft' : 'm';
  return '';
}

/** Convert a value to the active unit system (no formatting). */
export function convert(value: number, kind: 'distance' | 'speed' | 'altitude', units: UnitSystem): number {
  if (units === 'si') return value;
  if (kind === 'speed') return value * MPS_TO_MPH;
  return value * M_TO_FT; // distance and altitude both → feet
}
