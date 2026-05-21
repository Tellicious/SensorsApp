import { describe, it, expect } from 'vitest';
import {
  PeakTracker,
  PeakHold,
  RollingRms,
  RollingMean,
  RollingKurtosis,
  ChannelStats
} from '../../src/lib/dsp/kpi';

describe('PeakTracker', () => {
  it('tracks max absolute value', () => {
    const p = new PeakTracker();
    p.push(3); p.push(-7); p.push(2); p.push(5);
    expect(p.peak).toBe(7);
  });

  it('tracks peak-to-peak (max − min)', () => {
    const p = new PeakTracker();
    p.push(3); p.push(-7); p.push(2); p.push(5);
    expect(p.peakToPeak).toBe(12); // 5 - (-7)
  });

  it('reset clears state', () => {
    const p = new PeakTracker();
    p.push(5); p.push(-10);
    p.reset();
    expect(p.peak).toBe(0);
    expect(p.peakToPeak).toBe(0);
  });
});

describe('PeakHold', () => {
  it('latches an instantaneous peak with zero decay', () => {
    const ph = new PeakHold(0);   // no decay
    ph.push(2.0, 0);
    ph.push(0.1, 1000);
    expect(ph.hold).toBeCloseTo(2.0, 6);
  });

  it('decays at the configured dB/s rate', () => {
    const ph = new PeakHold(20);  // -20 dB per second = factor 0.1 per second
    ph.push(1.0, 0);
    ph.push(0.0, 1000); // 1 second later
    // 20*log10(linearFactor) = -20 ⇒ linear = 0.1
    expect(ph.hold).toBeCloseTo(0.1, 3);
  });

  it('reset clears state', () => {
    const ph = new PeakHold(5);
    ph.push(5, 0);
    ph.reset();
    expect(ph.hold).toBe(0);
  });
});

describe('RollingRms', () => {
  it('constant input ⇒ RMS equals abs(constant)', () => {
    const r = new RollingRms(100, 1);
    for (let i = 0; i < 50; i++) r.push(3, i * 10);
    expect(r.rms).toBeCloseTo(3, 3);
  });

  it('alternating ±1 ⇒ RMS = 1', () => {
    const r = new RollingRms(100, 1);
    for (let i = 0; i < 50; i++) r.push(i % 2 === 0 ? 1 : -1, i * 10);
    expect(r.rms).toBeCloseTo(1, 3);
  });

  it('zeros ⇒ RMS = 0', () => {
    const r = new RollingRms(100, 1);
    for (let i = 0; i < 50; i++) r.push(0, i * 10);
    expect(r.rms).toBe(0);
  });

  it('reset clears state', () => {
    const r = new RollingRms(100, 1);
    r.push(5, 0);
    r.reset();
    expect(r.rms).toBe(0);
  });
});

describe('RollingMean', () => {
  it('constant input ⇒ mean equals constant', () => {
    const m = new RollingMean(100, 1);
    for (let i = 0; i < 50; i++) m.push(7, i * 10);
    expect(m.mean).toBeCloseTo(7, 6);
  });

  it('signed input averages correctly', () => {
    const m = new RollingMean(100, 1);
    // ten samples summing to 30 → mean 3
    [1, 2, 3, 4, 5, 5, 4, 3, 2, 1].forEach((v, i) => m.push(v, i));
    expect(m.mean).toBeCloseTo(3, 6);
  });
});

describe('RollingKurtosis', () => {
  it('constant input ⇒ kurtosis = 0 (variance is 0, by code convention)', () => {
    const k = new RollingKurtosis(32);
    for (let i = 0; i < 16; i++) k.push(5);
    expect(k.kurtosis).toBe(0);
  });

  it('symmetric alternating ±1 has low excess kurtosis (≈ -2)', () => {
    const k = new RollingKurtosis(32);
    for (let i = 0; i < 32; i++) k.push(i % 2 === 0 ? 1 : -1);
    // For a binary distribution at ±1, m4/m2^2 = 1, excess = 1 - 3 = -2
    expect(k.kurtosis).toBeCloseTo(-2, 2);
  });
});

describe('ChannelStats (integration)', () => {
  it('updates peak, RMS, mean, and crest factor coherently', () => {
    const ch = new ChannelStats({
      capacity: 1000,
      rmsWindowSec: 1,
      meanWindowSec: 1,
      peakHoldDecayDbPerSec: 0
    });
    // Feed a square wave ±2
    for (let i = 0; i < 100; i++) ch.push(i % 2 === 0 ? 2 : -2, i * 10);
    expect(ch.peak.peak).toBe(2);
    expect(ch.rms.rms).toBeCloseTo(2, 3);
    expect(ch.crestFactor).toBeCloseTo(1, 3);   // square: peak = rms
    expect(ch.mean.mean).toBeCloseTo(0, 1);
  });

  it('reset() clears all internal trackers', () => {
    const ch = new ChannelStats({
      capacity: 100,
      rmsWindowSec: 1,
      meanWindowSec: 1,
      peakHoldDecayDbPerSec: 0
    });
    ch.push(5, 0);
    ch.reset();
    expect(ch.peak.peak).toBe(0);
    expect(ch.rms.rms).toBe(0);
    expect(ch.mean.mean).toBe(0);
    expect(ch.peakHold.hold).toBe(0);
  });
});
