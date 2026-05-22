<!--
  Root layout. Renders:
  - A top navigation bar with large title
  - The active page content
  - A bottom tab bar (iOS standard) for switching between modules

  Layout fix: the shell uses `position: fixed; inset: 0` instead of
  `height: 100dvh`. Previously, on iOS Safari's first paint the dynamic
  viewport unit was computed without accounting for the address-bar
  collapse, so the tab bar landed below the visible area until the user
  scrolled or interacted. Fixed positioning anchors the shell to the
  layout viewport directly, which is stable from the first frame.
-->
<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { settings } from '$lib/stores/settings';
  import { sessionState, stopLogging, logSessionEvent } from '$lib/stores/session';
  import { onMount } from 'svelte';

  let { children } = $props();

  let wakeLock: WakeLockSentinel | null = null;

  async function tryAcquireLock() {
    if (!navigator.wakeLock || !$settings.global.wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch { /* user denied or feature unavailable */ }
  }

  let online = $state(typeof navigator !== 'undefined' ? navigator.onLine : true);
  let pauseStartedAt: number | null = null;

  onMount(() => {
    document.documentElement.dataset.theme = $settings.global.theme;
    tryAcquireLock();

    const onVis = () => {
      if (document.visibilityState === 'visible') {
        tryAcquireLock();
        if (pauseStartedAt !== null) {
          logSessionEvent('resume', pauseStartedAt);
          pauseStartedAt = null;
        }
      } else {
        if ($sessionState.active) {
          pauseStartedAt = Date.now();
          logSessionEvent('pause', pauseStartedAt);
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);

    const onOnline = () => { online = true; };
    const onOffline = () => { online = false; };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      wakeLock?.release().catch(() => {});
    };
  });

  const tabs = [
    { href: `${base}/motion`,   label: 'Motion',   key: 'motion'   },
    { href: `${base}/audio`,    label: 'Audio',    key: 'audio'    },
    { href: `${base}/gps`,      label: 'GPS',      key: 'gps'      },
    { href: `${base}/settings`, label: 'Settings', key: 'settings' }
  ];

  function pageTitle(path: string): string {
    if (path.includes('/motion'))   return 'Motion';
    if (path.includes('/audio'))    return 'Audio';
    if (path.includes('/gps'))      return 'GPS';
    if (path.includes('/settings')) return 'Settings';
    return 'Sensor Lab';
  }

  function isActive(href: string) {
    return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
  }

  function onTabClick(e: MouseEvent, tabKey: string) {
    if (!$sessionState.active) return;
    if (tabKey === 'settings') return;
    if (tabKey === $sessionState.module) return;
    const ok = confirm(
      `Stop the active ${$sessionState.module} recording (${$sessionState.samplesWritten} samples)?`
    );
    if (!ok) {
      e.preventDefault();
      return;
    }
    stopLogging();
  }
</script>

<div class="shell">
  <header class="navbar">
    <div class="navbar-inner">
      <h1 class="large-title">{pageTitle(page.url.pathname)}</h1>
      <div class="nav-status">
        {#if !online}
          <span class="pill pill-warn" aria-label="Offline">
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path d="M2 2 L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M8 12.5 A1 1 0 1 1 8 14.5 A1 1 0 0 1 8 12.5 Z" fill="currentColor"/>
            </svg>
            Offline
          </span>
        {/if}
        {#if $sessionState.active}
          <span class="rec-pill">
            <span class="dot rec"></span>
            REC · {$sessionState.samplesWritten}
          </span>
        {/if}
      </div>
    </div>
  </header>

  <main>
    {@render children?.()}
  </main>

  <nav class="tabbar" aria-label="Modules">
    {#each tabs as t (t.key)}
      <a
        href={t.href}
        class:active={isActive(t.href)}
        aria-current={isActive(t.href) ? 'page' : undefined}
        onclick={(e) => onTabClick(e, t.key)}
      >
        {#if t.key === 'motion'}
          <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
            <path d="M2 14 L6 14 L8 8 L11 20 L14 4 L17 22 L20 10 L22 14 L26 14"
                  fill="none" stroke="currentColor" stroke-width="1.8"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {:else if t.key === 'audio'}
          <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
            <rect x="11" y="4" width="6" height="14" rx="3" fill="currentColor"/>
            <path d="M7 13 a7 7 0 0 0 14 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <line x1="14" y1="20" x2="14" y2="24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <line x1="10" y1="24" x2="18" y2="24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        {:else if t.key === 'gps'}
          <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
            <path d="M14 2 C9 2 5 6 5 11 c0 6 9 15 9 15 s9-9 9-15 c0-5-4-9-9-9 z"
                  fill="currentColor"/>
            <circle cx="14" cy="11" r="3.2" fill="var(--bg)"/>
          </svg>
        {:else}
          <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
            <path d="M14 9.5 a4.5 4.5 0 1 0 0 9 a4.5 4.5 0 0 0 0-9 z" fill="none" stroke="currentColor" stroke-width="1.8"/>
            <path d="M14 2 L14 5 M14 23 L14 26 M2 14 L5 14 M23 14 L26 14
                     M5.5 5.5 L7.6 7.6 M20.4 20.4 L22.5 22.5
                     M22.5 5.5 L20.4 7.6 M7.6 20.4 L5.5 22.5"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        {/if}
        <span>{t.label}</span>
      </a>
    {/each}
  </nav>
</div>

<style>
  /* CRITICAL: position:fixed anchors the shell to the layout viewport.
     100dvh/100vh on iOS Safari can leave the bottom bar off-screen on
     first paint, which is the "bar not at the bottom" symptom. */
  .shell {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    width: 100%;
    background: var(--bg-grouped);
    overflow: hidden;
  }

  .navbar {
    background: var(--bg);
    padding-top: var(--safe-top);
    border-bottom: 0.5px solid var(--separator);
    flex-shrink: 0;
  }
  .navbar-inner {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding: 4px 16px 8px;
    min-height: 52px;
    gap: 12px;
  }
  .navbar h1 {
    margin: 0;
    color: var(--fg);
  }

  .nav-status {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: var(--r-pill);
    font-size: var(--t-footnote);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .pill-warn {
    background: var(--warn-dim);
    color: var(--warn);
  }

  .rec-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--warn-dim);
    color: var(--warn);
    padding: 6px 10px;
    border-radius: var(--r-pill);
    font-size: var(--t-footnote);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  main {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .tabbar {
    display: flex;
    align-items: stretch;
    background: var(--bg-elev);
    border-top: 0.5px solid var(--separator);
    padding-bottom: var(--safe-bottom);
    flex-shrink: 0;
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
  }
  .tabbar a {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 8px 4px 6px;
    color: var(--fg-secondary);
    text-decoration: none;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.07px;
    transition: color 0.12s ease;
    min-height: 49px;
  }
  .tabbar a:active { opacity: 0.6; }
  .tabbar a.active { color: var(--tint); }
  .tabbar svg { flex-shrink: 0; }
</style>
