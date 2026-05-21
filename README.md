# Sensor Lab

> Offline-first PWA for iPhone Safari that turns the device into a portable
> measurement instrument for **motion** (accelerometer / gyroscope /
> orientation), **audio** (microphone with A/C/Z weighting and dB SPL
> calibration), and **GPS**. Live time- and frequency-domain visualizations,
> resettable KPIs, CSV/ZIP export.

Built to follow Apple's Human Interface Guidelines: SF Pro typography,
system-color palette light/dark, bottom tab bar, rounded cards, 44 pt
touch targets, drag-handle bottom sheets.

---

## Table of contents

1. [Features](#features)
2. [Stack](#stack)
3. [Quick start](#quick-start)
4. [Testing on a real iPhone](#testing-on-a-real-iphone)
5. [iOS permissions](#ios-permissions)
6. [Microphone calibration](#microphone-calibration)
7. [Architecture & data flow](#architecture--data-flow)
8. [File structure](#file-structure)
9. [Build & deploy](#build--deploy)
10. [Unit tests](#unit-tests)
11. [Known iOS Safari quirks](#known-ios-safari-quirks)
12. [What this app is not](#what-this-app-is-not)
13. [License](#license)

---

## Features

### Motion module
- **Acquisition** via `devicemotion` (acceleration) + `deviceorientation` (yaw/pitch/roll latched)
- **All sensor channels** exposed and toggleable from Settings:
  - `acceleration` — linear, gravity removed (x, y, z, |a|)
  - `accelerationIncludingGravity` — raw including gravity
  - `rotationRate` — gyroscope (deg/s)
  - `deviceorientation` — alpha/beta/gamma (deg)
- **Sample rate measured at runtime** and shown in the status strip (typically ~60 Hz on iOS)
- **Time-domain chart** with selectable window: 1 / 5 / 10 / 30 / 60 s
- **FFT chart** with full configurability:
  - Size: 256 / 512 / 1024 / 2048 / 4096
  - Window: rectangular, Hann, Hamming, Blackman, Blackman-Harris, flat-top
  - Overlap: 0 / 25 / 50 / 75 %
  - Linear or log Y (dB), linear or log X (frequency)
  - Manual Y range or auto-scale
- **Six live KPIs** for magnitude |a| (tap any tile to reset that KPI):
  Peak · RMS · Crest factor · Kurtosis · Peak-hold (configurable dB/s decay) · Peak-to-peak
- **Per-axis KPIs** (Peak / RMS / Avg per visible axis) when X / Y / Z are toggled in Settings
- **Channel toggles** in Settings render a separate sub-chart for each enabled group:
  linear acceleration (m/s²), raw-with-gravity, gyroscope (deg/s), orientation (deg).
  Multiple groups can be enabled at once and stack vertically.
- **N dominant frequencies** with parabolic-interpolation sub-bin precision (N configurable)
- **3D orientation cube** (optional, toggle in Settings → Motion) — a small
  Three.js scene shaped like an iPhone that mirrors the device's α/β/γ in
  real time. Three.js is dynamic-imported so non-users don't pay for it.
- **Logging** to IndexedDB with batched 500 ms flush, **CSV export** per session

### Audio module
- **Acquisition** via `getUserMedia({audio: true})` with `echoCancellation`,
  `noiseSuppression`, `autoGainControl` all **disabled** — pure raw mic
- **Sample rate** read from `AudioContext` (typically 48 kHz on recent iPhones)
- **Live waveform** — selectable window 50 / 100 / 500 / 1000 ms (toggleable)
- **Live spectrum** — FFT up to 32 768 samples, all the same options as Motion (toggleable)
- **Scrolling spectrogram** — canvas waterfall display with viridis colormap,
  log-frequency Y axis. Optional, toggled from Settings → Audio → display.
- **A/C/Z frequency weighting** per IEC 61672-1
- **Microphone calibration wizard** — three methods (see [below](#microphone-calibration))
- **Calibrated units**: dBFS / dB(A) / dB(C) / dB SPL, automatically labelled
- **Live KPIs**: Peak · RMS · Leq (equivalent continuous level over session) · Crest factor (dB)
- **N dominant frequencies** (sub-bin parabolic interpolation)
- **No logging by design** — at 48 kHz audio fills IndexedDB quotas in
  minutes. The Log/CSV buttons are visually disabled with a tooltip.

### GPS module
- **Acquisition** via `geolocation.watchPosition` with `enableHighAccuracy: true`
- **Numeric panel** (always visible) with all fields from the Geolocation API:
  Latitude · Longitude (decimal or DMS) · Altitude · Heading · Speed (m/s & km/h, or mph in Imperial) ·
  Horizontal/vertical accuracy · Satellites row (marked *N/A*, not exposed by Web API)
- **Offline-capable map** using Leaflet + OSM tiles cached by the service worker
  (stale-while-revalidate, LRU-bounded)
  - Live position marker, polyline track, "Center on me" and "Fit track" buttons
- **Mini time-series charts**: speed over time, altitude over time, **bearing
  over time** (0–360° with NaN-breaks at compass-wraparound for clean rendering)
- **Ten live KPIs**:
  Distance (Haversine) · Speed max / min / avg / median · Elevation gain ± · Time moving
  (configurable threshold) · Bearing circular mean · Mean accuracy
- **Logging** to IndexedDB, **CSV export** per session

### Cross-cutting
- **Settings** persisted in localStorage; export / import JSON; reset to defaults
- **Storage panel** showing IndexedDB usage / quota with one-tap wipe
- **Bulk export**: every recorded session as a single ZIP of CSVs
- **PWA**: installable to Home Screen, fully offline after first load
- **Wake Lock** so the screen doesn't sleep during long acquisitions
- **Themes**: dark / light / auto (follows iOS appearance setting)

---

## Stack

| Layer | Library | Why |
|---|---|---|
| Framework | **SvelteKit 2** + **Svelte 5 (runes)** | Static export, no virtual DOM, ideal for 60 Hz data streaming |
| Static export | `@sveltejs/adapter-static` | Plain HTML/JS/CSS, deployable on GitHub Pages |
| Build | **Vite 5** | Fast HMR, modern bundling |
| Type system | **TypeScript 5** | Full type safety |
| Charts | **uPlot** | Fastest canvas-based time-series renderer on the market |
| Map | **Leaflet** | Solid offline-tile story |
| 3D | **Three.js** (dynamic-imported) | Orientation cube on the Motion page |
| Storage | **Dexie** (IndexedDB) | Clean Promise-based API around IndexedDB |
| FFT | **fft.js** (radix-2) | Small, fast, well-tested |
| ZIP | **JSZip** | Bulk export of all sessions |
| PWA | **@vite-pwa/sveltekit** + Workbox | Service worker, precache, runtime tile cache |
| Tests | **Vitest 2** | Native ESM, fast, Vite-aware |

Bundle target: ≲ 500 KB gzipped cold load.

---

## Quick start

```bash
npm install
npm run dev:https        # HTTPS is mandatory: sensors don't work over HTTP
```

Vite prints a `https://localhost:5173/` URL. Accept the self-signed cert.

### NPM scripts

| Script | What it does |
|---|---|
| `npm run dev` | Local dev server, HTTP (sensors won't work — use `dev:https` instead) |
| `npm run dev:https` | Local dev server with self-signed HTTPS |
| `npm run build` | Production static build into `build/` |
| `npm run preview` | Preview the production build |
| `npm run check` | Type-check via svelte-check |
| `npm test` | Run the Vitest unit-test suite once |
| `npm run test:watch` | Vitest in watch mode |

---

## Testing on a real iPhone

The desktop browser cannot reproduce iOS Safari's permission flow or the
60 Hz cap on devicemotion events. **Always validate on device.**

### Option A — same Wi-Fi, self-signed cert

```bash
npm run dev:https
```

On the iPhone, open `https://<your-mac-ip>:5173/`
(find the IP with `ipconfig getifaddr en0` on macOS).
Safari will warn about the certificate; tap *Advanced → Visit anyway*.

### Option B — public tunnel

Use **ngrok** or **Cloudflare Tunnel** to expose your dev server with a
real HTTPS cert:

```bash
ngrok http 5173
```

Open the printed `*.ngrok.io` URL on the iPhone.

### Install to Home Screen

In Safari: *Share → Add to Home Screen*. The app then runs full-screen
with offline support. (iOS doesn't surface an install prompt — manual.)

---

## iOS permissions

| Capability | When iOS asks | What to do |
|---|---|---|
| Motion & Orientation | First tap of **Start** on the Motion page | Tap *Allow* |
| Microphone | First tap of **Start** on the Audio page | Tap *Allow* |
| Location | First tap of **Start** on the GPS page | Tap *Allow While Using* |

On iOS 13+, motion permission **also** requires
*Settings → Safari → Motion & Orientation Access* to be **On**. If it's off,
the in-page prompt won't appear at all and the app shows a denied banner.

---

## Microphone calibration

The Audio module displays levels in **dBFS** by default — full-scale digital,
no acoustic reference. To get true **dB SPL** ("dB" in the everyday sense),
run the calibration wizard from Settings → Audio → Calibrate. It supports
three methods:

### Method A · External reference (recommended)
Use a pistonphone (94 / 114 dB SPL @ 1 kHz) or another already-calibrated
SPL meter app on a second device. Wizard procedure:

1. 3-second countdown, then 10-second integration with A-weighting
2. Computes `Leq` of the 10 s sample
3. `offset = referenceLevel − Leq_measured`
4. Reports σ of per-frame levels as a stability check
   (σ > 1 dB ⇒ environment unstable; retry recommended)

### Method B · Manual sensitivity
Enter the published microphone sensitivity in dBV/Pa plus any preamp gain.
Using `1 Pa = 94 dB SPL`:
`offset = 94 − (sensitivity_dBV/Pa + preampGain_dB)`. Theoretical — accuracy
limited.

### Method C · Skip
Clears calibration, keep all readings in dBFS / dB(A) / dB(C) without
any SPL reference.

Calibration is persisted in localStorage. The unit label everywhere in
the audio page switches automatically based on the active state.

---

## Architecture & data flow

```
                ┌─────────────────────────────────────────┐
                │  routes/{motion,audio,gps,settings}     │
                │  routes/+layout.svelte (nav, wake lock) │
                └────┬──────────────────────────────┬─────┘
                     │                              │ subscribe
                     ▼                              ▼
       ┌──────────────────┐                ┌─────────────────────┐
       │ lib/sensors/     │                │ lib/stores/         │
       │   motion.ts      │                │   settings.ts       │  ←─ localStorage
       │   audio.ts       │                │   session.ts        │
       │   gps.ts         │                └─────────────────────┘
       └────┬─────────────┘                          ▲
            │ samples                                │ pushMotion / pushGps
            ▼                                        │
       ┌──────────────────┐    KPI / FFT    ┌────────┴────────┐
       │ lib/dsp/         │ ◀──────────────▶│  page state +   │
       │   windowing.ts   │                 │  uPlot charts   │
       │   fft.ts         │                 └─────────────────┘
       │   weighting.ts   │
       │   kpi.ts         │                 ┌─────────────────┐
       └──────────────────┘                 │ lib/storage/    │
                                            │   db.ts (Dexie) │
       ┌──────────────────┐  bulkAdd 500ms  │   csv.ts        │  ─→  CSV/ZIP download
       │ session store    │ ───────────────▶│                 │
       └──────────────────┘                 └─────────────────┘
```

Each module page:
1. Allocates pre-sized `Float64Array` circular buffers (no `push` → no GC)
2. Subscribes to the sensor controller's callback
3. Updates online KPIs (`ChannelStats`) per sample, in O(1) where possible
4. Recomputes FFT every `size × (1 − overlap/100)` samples (the "hop")
5. Refreshes the DOM at ~10 Hz via a `tick` counter; uPlot internally
   throttles canvas redraws to ~30 fps
6. Forwards samples to the session store (no-op when not logging)

---

## File structure

```
.
├── .github/
│   ├── dependabot.yml                  # weekly npm + monthly action upgrades
│   └── workflows/deploy.yml            # test → build → deploy GH Pages pipeline
├── src/
│   ├── app.html                        # base HTML shell (theme color, apple-touch icon, meta)
│   ├── app.css                         # iOS HIG design tokens (colors, type ramp, components)
│   ├── app.d.ts                        # ambient TS — iOS permission APIs, Wake Lock
│   │
│   ├── lib/
│   │   ├── components/
│   │   │   ├── KpiCard.svelte          # one tappable KPI tile with magnitude-aware formatter
│   │   │   ├── TimeChart.svelte        # scrolling time-series, uPlot, resolves CSS vars at mount
│   │   │   ├── FftChart.svelte         # spectrum chart, lin/log axes
│   │   │   ├── FooterControls.svelte   # iOS-style page toolbar (Start/Reset/Log/CSV)
│   │   │   ├── CalibrationWizard.svelte# bottom-sheet 3-method mic calibration wizard
│   │   │   └── OrientationCube.svelte  # lazy-loaded Three.js cube driven by deviceorientation
│   │   │
│   │   ├── dsp/
│   │   │   ├── windowing.ts            # 6 window functions, coherent gain, ENBW
│   │   │   ├── fft.ts                  # FftProcessor + dominantFrequencies (parabolic interp)
│   │   │   ├── weighting.ts            # IEC 61672-1 A/C weighting + Leq
│   │   │   └── kpi.ts                  # Peak / PeakHold (dB/s decay) / RollingRms / Mean /
│   │   │                                 Kurtosis / ChannelStats bundle
│   │   │
│   │   ├── sensors/
│   │   │   ├── motion.ts               # devicemotion + iOS requestPermission flow, Hz estimator
│   │   │   ├── audio.ts                # getUserMedia + AnalyserNode, browser DSP disabled
│   │   │   └── gps.ts                  # watchPosition wrapper + Haversine helper
│   │   │
│   │   ├── storage/
│   │   │   ├── db.ts                   # Dexie schema (sessions, samples_motion, samples_gps)
│   │   │   └── csv.ts                  # CSV generation, escape, ZIP bulk export
│   │   │
│   │   └── stores/
│   │       ├── settings.ts             # all user settings, localStorage-backed, JSON import/export
│   │       └── session.ts              # active logging session, 500 ms batched flush
│   │
│   └── routes/
│       ├── +layout.svelte              # iOS large-title nav + bottom tab bar + wake lock
│       ├── +layout.ts                  # disables SSR (this is a client-only PWA)
│       ├── +page.svelte                # root → /motion redirect
│       ├── motion/+page.svelte         # Motion page (time/FFT charts + 6 KPIs + dominants)
│       ├── audio/+page.svelte          # Audio page (waveform/spectrum + 4 KPIs + calibration strip)
│       ├── gps/+page.svelte            # GPS page (coordinates + map + mini-charts + 9 KPIs)
│       └── settings/+page.svelte       # iOS grouped-list settings UI + storage + backup/restore
│
├── tests/                              # Vitest unit tests for pure functions
│   ├── dsp/
│   │   ├── windowing.test.ts           # 12 tests
│   │   ├── fft.test.ts                 # 8 tests — sine peak, DC, dominants, parabolic interp
│   │   ├── weighting.test.ts           # 26 tests — IEC 61672-1 reference values
│   │   └── kpi.test.ts                 # 16 tests — peak, RMS, peak-hold decay, ChannelStats
│   ├── sensors/
│   │   └── gps.test.ts                 # 5 tests — Haversine (Milan↔Rome, equator, antipodal)
│   └── storage/
│       └── csv.test.ts                 # 8 tests — RFC 4180 edge cases
│
├── static/
│   ├── manifest.webmanifest            # PWA manifest
│   ├── favicon.svg                     # browser favicon
│   └── icons/                          # 192 / 512 / 512-maskable PNGs
│
├── package.json
├── svelte.config.js                    # adapter-static with BASE_PATH for GH Pages
├── vite.config.ts                      # @vite-pwa/sveltekit + OSM tile runtime cache
├── vitest.config.ts                    # Node env, $lib alias
├── tsconfig.json
└── README.md                           # this file
```

---

## Build & deploy

### Local

```bash
npm run build
npm run preview
```

### GitHub Pages (automated)

`.github/workflows/deploy.yml` runs on every push to `main` and every PR.
The workflow is staged:

1. **test** — `npm ci` + `svelte-kit sync` + `npm test`. Must pass.
2. **build** — only after **test** succeeds, only on `main` pushes (not PRs).
   Builds with `BASE_PATH=/<repo-name>` so URLs resolve under `/<repo-name>/`.
3. **deploy** — uploads `build/` to GitHub Pages.

To enable:
1. Repo *Settings → Pages*, set source to **GitHub Actions**
2. Push to `main` — first run takes ~2 min
3. App lives at `https://<user>.github.io/<repo-name>/`

For a custom domain or root deployment, override `BASE_PATH=` (empty) in
the workflow env.

### Dependabot

`.github/dependabot.yml` keeps things current:
- **npm**: weekly (Monday), grouped into `svelte`, `vite`, `dev-deps`
- **github-actions**: monthly

---

## Unit tests

The pure-function layer (DSP, Haversine, CSV escape) is covered by
**Vitest**:

```
$ npm test
 ✓ tests/dsp/fft.test.ts        (8 tests)
 ✓ tests/dsp/kpi.test.ts        (16 tests)
 ✓ tests/dsp/weighting.test.ts  (26 tests)
 ✓ tests/dsp/windowing.test.ts  (12 tests)
 ✓ tests/sensors/gps.test.ts    (5 tests)
 ✓ tests/storage/csv.test.ts    (8 tests)
 Test Files  6 passed (6)
      Tests  75 passed (75)
```

What's covered:
- **windowing**: every window of correct length, Hann/Hamming/Blackman
  symmetry and endpoint values, coherent gain and ENBW for known windows
- **fft**: pure-sine peak at correct bin with correct amplitude, DC
  in bin 0, frequency-bin spacing, dominantFrequencies sort/limit,
  parabolic interpolation yielding sub-bin precision
- **weighting**: 20 reference values from IEC 61672-1 Table 2 (A and C
  curves), `applyWeightingDb` in-place and out-of-place
- **kpi**: PeakTracker max-abs and peak-to-peak, PeakHold dB/s decay
  with known time-step, RollingRms / RollingMean with known inputs,
  ChannelStats integration on a square wave (peak == rms == crest 1.0)
- **gps**: Haversine on Milan↔Rome (477 km), one degree at the equator
  (~111 km), antipodal points (~20 015 km), symmetry, zero distance
- **csv**: RFC 4180 — commas, quotes, newlines, doubled quotes, null
  vs. empty vs. 0

Browser-dependent code (Web Audio, devicemotion, Geolocation, Leaflet,
Dexie writes) is not unit-tested here — verify those on a real iPhone.

---

## Known iOS Safari quirks

- **DeviceMotion** is capped at ~60 Hz, regardless of what
  `requestAnimationFrame` reports. The status strip shows the actual
  measured rate.
- **Backgrounding**: when the app goes into the background or the screen
  locks, sensor events stop. The Wake Lock setting (Settings → General →
  Keep screen awake) prevents the screen from sleeping; we re-acquire the
  lock on every `visibilitychange` since iOS releases it. While a session
  is logging, pause / resume events are written to IndexedDB and surface in
  the exported CSV's metadata header (`# pause_resume_events: [...]`) so
  you can identify and account for data gaps.
- **AudioContext sample rate** is normally 48 kHz on recent iPhones —
  always read it from `audioContext.sampleRate`, never hardcode.
- **IndexedDB quota** is shared across Safari origins and can be evicted
  under storage pressure. The Settings → Storage panel shows live usage,
  bar fill, and a one-tap wipe.
- **Tile cache** for the map is bounded by Workbox (`maxEntries: 2000`,
  `maxAgeSeconds: 30d`). Browse the area you'll need while online so
  Workbox can populate the cache before going offline.
- **Install on iOS**: there is no PWA install prompt on iOS; use
  *Share → Add to Home Screen* in Safari to get the full-screen
  standalone experience.
- **Offline indicator**: a small "Offline" pill appears in the navigation
  bar when `navigator.onLine === false`. The app continues to function;
  only un-cached map tiles outside the visited area are affected.

---

## What this app is not

- No cloud sync, no accounts, no push notifications — by design. All data
  stays on device.
- No multi-session comparison UI — export CSV/ZIP and analyze in pandas,
  MATLAB, or your tool of choice.
- No automatic triggers — all start/stop is manual.

---

## License

MIT
