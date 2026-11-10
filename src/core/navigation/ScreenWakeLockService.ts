import { Capacitor, registerPlugin } from '@capacitor/core';

interface ScreenKeepAwakePlugin {
  keepAwake(): Promise<void>;
  allowSleep(): Promise<void>;
}

const ScreenKeepAwakeNative = registerPlugin<ScreenKeepAwakePlugin>('ScreenKeepAwake');

type WakeLockSentinelLike = {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
  removeEventListener?: (type: 'release', listener: () => void) => void;
};

export class ScreenWakeLockService {
  /**
   * Keeps the device/machine screen awake while navigation is active.
   * Uses both Capacitor native window keep-awake (Android/iOS) and the Web Screen Wake Lock API
   * with automatic re-acquisition on visibilitychange.
   *
   * Returns a synchronous release function to restore normal screen sleep when navigation exits.
   */
  static acquireNavigationWakeLock(onStateChange?: (isActive: boolean) => void): () => void {
    let disposed = false;
    let sentinel: WakeLockSentinelLike | null = null;
    let isCurrentlyActive = false;

    const notify = (next: boolean) => {
      if (isCurrentlyActive === next) return;
      isCurrentlyActive = next;
      onStateChange?.(next);
    };

    const requestNativeKeepAwake = async () => {
      if (!Capacitor.isNativePlatform()) return;
      try {
        await ScreenKeepAwakeNative.keepAwake();
        if (!disposed) notify(true);
      } catch {
        // Fallback to Web Wake Lock API below
      }
    };

    const requestWebWakeLock = async () => {
      if (disposed) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (sentinel && sentinel.released !== true) return;

      const navAny = typeof navigator !== 'undefined' ? (navigator as any) : undefined;
      if (!navAny?.wakeLock || typeof navAny.wakeLock.request !== 'function') {
        return;
      }

      try {
        const acquired: WakeLockSentinelLike = await navAny.wakeLock.request('screen');
        if (disposed) {
          void acquired.release().catch(() => {});
          return;
        }
        sentinel = acquired;
        notify(true);

        const handleSentinelRelease = () => {
          if (sentinel === acquired) {
            sentinel = null;
          }
          if (!disposed && !Capacitor.isNativePlatform()) {
            notify(false);
          }
        };
        acquired.addEventListener?.('release', handleSentinelRelease);
      } catch {
        // Browser may require user interaction or battery-saver may temporarily deny;
        // visibilitychange / pointerdown listeners below will retry automatically.
      }
    };

    const acquireAll = () => {
      if (disposed) return;
      void requestNativeKeepAwake();
      void requestWebWakeLock();
    };

    const handleVisibilityChange = () => {
      if (!disposed && document.visibilityState === 'visible') {
        acquireAll();
      }
    };

    const handleUserGestureRetry = () => {
      if (!disposed && (!sentinel || sentinel.released)) {
        void requestWebWakeLock();
      }
    };

    acquireAll();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', handleUserGestureRetry, { passive: true });
      window.addEventListener('keydown', handleUserGestureRetry, { passive: true });
    }

    return () => {
      disposed = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', handleUserGestureRetry);
        window.removeEventListener('keydown', handleUserGestureRetry);
      }
      if (sentinel) {
        const toRelease = sentinel;
        sentinel = null;
        void toRelease.release().catch(() => {});
      }
      if (Capacitor.isNativePlatform()) {
        void ScreenKeepAwakeNative.allowSleep().catch(() => {});
      }
      notify(false);
    };
  }
}
