import { Capacitor, registerPlugin } from '@capacitor/core';
import { Geolocation, type Position } from '@capacitor/geolocation';

export interface LiveGpsFix {
  lon: number;
  lat: number;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  timestamp: number;
  fixAgeMs?: number;
}

export interface NativeGpsPosition extends Position {
  fixAgeMs?: number | null;
}

export interface NativeGpsPlugin {
  checkPermissions(): Promise<{ location?: string; coarseLocation?: string }>;
  requestPermissions(options?: {
    permissions?: Array<'location' | 'coarseLocation'>;
  }): Promise<{ location?: string; coarseLocation?: string }>;
  getCurrentPosition(options?: LiveGpsWatchOptions): Promise<NativeGpsPosition>;
  watchPosition(
    options: LiveGpsWatchOptions,
    callback: (position: NativeGpsPosition | null, err?: any) => void
  ): Promise<string>;
  clearWatch(options: { id: string }): Promise<void>;
}

export const NativeGps = registerPlugin<NativeGpsPlugin>('NativeGps');

export interface LiveGpsError {
  code?: number;
  message: string;
  isPermissionDenied: boolean;
}

export interface LiveGpsWatchOptions {
  enableHighAccuracy?: boolean;
  maximumAge?: number;
  timeout?: number;
  minimumUpdateInterval?: number;
}

const DEFAULT_WATCH_OPTIONS: Required<LiveGpsWatchOptions> = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 10000,
  minimumUpdateInterval: 500,
};

export function normalizeGpsPosition(raw: {
  timestamp?: number;
  fixAgeMs?: number | null;
  coords?: {
    longitude?: number;
    latitude?: number;
    accuracy?: number | null;
    altitude?: number | null;
    heading?: number | null;
    speed?: number | null;
  };
} | null | undefined): LiveGpsFix | null {
  if (!raw?.coords) return null;
  const lon = Number(raw.coords.longitude);
  const lat = Number(raw.coords.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }
  const accuracy =
    typeof raw.coords.accuracy === 'number' && Number.isFinite(raw.coords.accuracy)
      ? raw.coords.accuracy
      : null;
  const altitude =
    typeof raw.coords.altitude === 'number' && Number.isFinite(raw.coords.altitude)
      ? raw.coords.altitude
      : null;
  const heading =
    typeof raw.coords.heading === 'number' &&
    Number.isFinite(raw.coords.heading) &&
    raw.coords.heading >= 0
      ? raw.coords.heading % 360
      : null;
  const speed =
    typeof raw.coords.speed === 'number' &&
    Number.isFinite(raw.coords.speed) &&
    raw.coords.speed >= 0
      ? raw.coords.speed
      : null;

  const out: LiveGpsFix = {
    lon,
    lat,
    accuracy,
    altitude,
    heading,
    speed,
    timestamp:
      typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
        ? raw.timestamp
        : Date.now(),
  };

  if (
    typeof raw.fixAgeMs === 'number' &&
    Number.isFinite(raw.fixAgeMs) &&
    raw.fixAgeMs >= 0
  ) {
    out.fixAgeMs = raw.fixAgeMs;
  }

  return out;
}

function toLiveGpsError(err: unknown): LiveGpsError {
  const code = typeof (err as any)?.code === 'number' ? (err as any).code : undefined;
  const message =
    typeof (err as any)?.message === 'string' && (err as any).message.trim()
      ? (err as any).message
      : 'Location unavailable';
  const errCode = String((err as any)?.code || '').toUpperCase();
  const isPermissionDenied =
    code === 1 || errCode === 'OS-PLUG-GLOC-0003' || /denied|permission/i.test(message);
  return { code, message, isPermissionDenied };
}

function isPluginUnavailableError(err: unknown): boolean {
  const errCode = String((err as any)?.code || '').toUpperCase();
  const message = String((err as any)?.message || '');
  return (
    errCode === 'UNIMPLEMENTED' ||
    errCode === 'UNAVAILABLE' ||
    /not implemented|not available/i.test(message)
  );
}

export class LiveGpsService {
  /**
   * Starts a continuous, high-accuracy GPS position stream across Web PWA and Capacitor Native (Android/iOS).
   * Returns a synchronous cleanup function that stops watching immediately.
   */
  static startContinuousWatch(
    onFix: (fix: LiveGpsFix) => void,
    onError?: (err: LiveGpsError) => void,
    options?: LiveGpsWatchOptions
  ): () => void {
    const resolvedOptions: Required<LiveGpsWatchOptions> = {
      ...DEFAULT_WATCH_OPTIONS,
      ...options,
    };

    let disposed = false;
    let browserWatchId: number | null = null;
    let coarseWatchId: number | null = null;
    let nativeWatchHandle: { provider: NativeGpsPlugin; id: string } | null = null;
    let nativeCoarseHandle: { provider: NativeGpsPlugin; id: string } | null = null;
    let hasPrimaryFix = false;

    const clearNativeHandle = (handle: { provider: NativeGpsPlugin; id: string } | null) => {
      if (!handle) return;
      void handle.provider.clearWatch({ id: handle.id }).catch(() => {});
    };

    const startBrowserWatch = () => {
      if (disposed) return;
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        onError?.({
          message: 'Geolocation API is not supported on this device',
          isPermissionDenied: false,
        });
        return;
      }

      // Fast initial seed fix so the position icon shows immediately indoors/on desktop
      // while high-accuracy GPS watch is warming up.
      if (typeof navigator.geolocation.getCurrentPosition === 'function') {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (disposed || hasPrimaryFix) return;
            const fix = normalizeGpsPosition(pos);
            if (fix) onFix(fix);
          },
          () => {
            // Ignore seed failure; primary watch below handles continuous stream & errors
          },
          { enableHighAccuracy: false, maximumAge: 120000, timeout: 5000 }
        );
      }

      browserWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (disposed) return;
          hasPrimaryFix = true;
          if (coarseWatchId !== null) {
            navigator.geolocation.clearWatch(coarseWatchId);
            coarseWatchId = null;
          }
          const fix = normalizeGpsPosition(pos);
          if (fix) onFix(fix);
        },
        (err) => {
          if (disposed) return;
          const liveErr = toLiveGpsError(err);
          // On indoor/desktop machines where high-accuracy GPS times out, start a coarse
          // network/Wi-Fi watch as fallback so the user's icon continues updating.
          if (!liveErr.isPermissionDenied && !hasPrimaryFix && coarseWatchId === null) {
            coarseWatchId = navigator.geolocation.watchPosition(
              (pos) => {
                if (disposed || hasPrimaryFix) return;
                const fix = normalizeGpsPosition(pos);
                if (fix) onFix(fix);
              },
              (coarseErr) => {
                if (!disposed && !hasPrimaryFix) {
                  onError?.(toLiveGpsError(coarseErr));
                }
              },
              { enableHighAccuracy: false, maximumAge: 15000, timeout: 15000 }
            );
            return;
          }
          onError?.(liveErr);
        },
        {
          enableHighAccuracy: resolvedOptions.enableHighAccuracy,
          maximumAge: resolvedOptions.maximumAge,
          timeout: resolvedOptions.timeout,
        }
      );
    };

    if (Capacitor.isNativePlatform()) {
      (async () => {
        const isAndroid =
          typeof Capacitor.getPlatform === 'function' && Capacitor.getPlatform() === 'android';
        const capPlugins = (Capacitor as any).Plugins as
          | Record<string, NativeGpsPlugin | undefined>
          | undefined;
        const nativeGpsProvider = capPlugins?.NativeGps ?? NativeGps;
        const geoProvider = (capPlugins?.Geolocation ?? Geolocation) as NativeGpsPlugin;
        const nativePluginReady =
          isAndroid &&
          (typeof Capacitor.isPluginAvailable !== 'function' ||
            Capacitor.isPluginAvailable('NativeGps'));

        const runWithProvider = async (
          provider: NativeGpsPlugin,
          useShortAndroidWatchTimeout: boolean
        ): Promise<boolean> => {
          const perm = await provider.checkPermissions();
          if (disposed) return true;
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
            const req = await provider.requestPermissions();
            if (disposed) return true;
            if (req.location !== 'granted' && req.coarseLocation !== 'granted') {
              onError?.({
                code: 1,
                message: 'Location permission denied',
                isPermissionDenied: true,
              });
              return true;
            }
          }

          // Fast native coarse/cached seed so position icon renders immediately indoors
          void provider
            .getCurrentPosition({
              enableHighAccuracy: false,
              maximumAge: 120000,
              timeout: 5000,
            })
            .then((pos) => {
              if (disposed || hasPrimaryFix) return;
              const fix = normalizeGpsPosition(pos);
              if (fix) onFix(fix);
            })
            .catch(() => {});

          // Note: @capacitor/geolocation (iongeolocation-android-1.0.0) uses `options.timeout` as
          // FusedLocationProvider's active `intervalMillis`. Pass the high-rate update interval on
          // Android so fallback watches never degrade to 10-second polling.
          const watchIntervalMs = Math.max(
            500,
            Math.min(resolvedOptions.minimumUpdateInterval, 1000)
          );
          const nativeWatchTimeoutMs = useShortAndroidWatchTimeout
            ? watchIntervalMs
            : resolvedOptions.timeout;

          const id = await provider.watchPosition(
            {
              enableHighAccuracy: resolvedOptions.enableHighAccuracy,
              maximumAge: resolvedOptions.maximumAge,
              timeout: nativeWatchTimeoutMs,
              minimumUpdateInterval: resolvedOptions.minimumUpdateInterval,
            },
            (pos, err) => {
              if (disposed) return;
              if (err) {
                const liveErr = toLiveGpsError(err);
                if (!liveErr.isPermissionDenied && !hasPrimaryFix && nativeCoarseHandle === null) {
                  void provider
                    .watchPosition(
                      {
                        enableHighAccuracy: false,
                        maximumAge: 15000,
                        timeout: useShortAndroidWatchTimeout
                          ? Math.max(1000, watchIntervalMs)
                          : 15000,
                        minimumUpdateInterval: resolvedOptions.minimumUpdateInterval,
                      },
                      (coarsePos, coarseErr) => {
                        if (disposed || hasPrimaryFix) return;
                        if (coarseErr) {
                          onError?.(toLiveGpsError(coarseErr));
                          return;
                        }
                        const fix = normalizeGpsPosition(coarsePos);
                        if (fix) onFix(fix);
                      }
                    )
                    .then((cid) => {
                      if (disposed || hasPrimaryFix) {
                        clearNativeHandle({ provider, id: cid });
                      } else {
                        nativeCoarseHandle = { provider, id: cid };
                      }
                    })
                    .catch(() => {
                      if (!disposed) onError?.(liveErr);
                    });
                  return;
                }
                onError?.(liveErr);
                return;
              }
              hasPrimaryFix = true;
              if (nativeCoarseHandle !== null) {
                const handleToClear = nativeCoarseHandle;
                nativeCoarseHandle = null;
                clearNativeHandle(handleToClear);
              }
              const fix = normalizeGpsPosition(pos);
              if (fix) onFix(fix);
            }
          );

          if (disposed) {
            clearNativeHandle({ provider, id });
          } else {
            nativeWatchHandle = { provider, id };
          }
          return true;
        };

        if (nativePluginReady) {
          try {
            await runWithProvider(nativeGpsProvider, false);
            return;
          } catch (nativeErr) {
            if (disposed) return;
            if (!isPluginUnavailableError(nativeErr)) {
              const liveErr = toLiveGpsError(nativeErr);
              if (liveErr.isPermissionDenied) {
                onError?.(liveErr);
                return;
              }
            }
          }
        }

        try {
          await runWithProvider(geoProvider, isAndroid);
        } catch {
          if (!disposed) {
            startBrowserWatch();
          }
        }
      })();
    } else {
      startBrowserWatch();
    }

    return () => {
      disposed = true;
      if (browserWatchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(browserWatchId);
        browserWatchId = null;
      }
      if (coarseWatchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(coarseWatchId);
        coarseWatchId = null;
      }
      if (nativeWatchHandle !== null) {
        const handleToClear = nativeWatchHandle;
        nativeWatchHandle = null;
        clearNativeHandle(handleToClear);
      }
      if (nativeCoarseHandle !== null) {
        const handleToClear = nativeCoarseHandle;
        nativeCoarseHandle = null;
        clearNativeHandle(handleToClear);
      }
    };
  }
}
