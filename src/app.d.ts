// See https://svelte.dev/docs/kit/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  // iOS-only permission API on DeviceMotionEvent / DeviceOrientationEvent
  interface DeviceMotionEventConstructor {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  }
  interface DeviceOrientationEventConstructor {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  }

  // Wake Lock API
  interface WakeLockSentinel extends EventTarget {
    release(): Promise<void>;
    released: boolean;
  }
  interface Navigator {
    wakeLock?: {
      request(type: 'screen'): Promise<WakeLockSentinel>;
    };
  }
}

export {};
