import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getAppVersion } from './core/appVersion';
import './index.css';

const DEPLOYED_VERSION_KEY = 'navapp.deployedVersion.v1';
const RELOADED_VERSION_KEY = 'navapp.reloadedForVersion.v1';
const APP_SHELL_CACHE_PREFIX = 'navapp-offline-';
const VERSION_CHECK_THROTTLE_MS = 45_000;

async function clearStaleAppShellCaches(keepCacheName?: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(APP_SHELL_CACHE_PREFIX) && k !== keepCacheName)
        .map((k) => caches.delete(k))
    );
  } catch {
    // Ignore restricted cache environments
  }
}

async function applyNewDeployReload(
  nextVersion: string,
  swRegistration?: ServiceWorkerRegistration | null
): Promise<void> {
  try {
    if (sessionStorage.getItem(RELOADED_VERSION_KEY) === nextVersion) {
      return;
    }
    sessionStorage.setItem(RELOADED_VERSION_KEY, nextVersion);
  } catch {
    // Continue cache clear even if sessionStorage is unavailable
  }
  await clearStaleAppShellCaches();
  await swRegistration?.update().catch(() => {});
  window.location.reload();
}

async function checkRemoteDeployVersion(
  currentVersion: string,
  swRegistration?: ServiceWorkerRegistration | null
): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  try {
    const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const payload = (await res.json()) as { version?: unknown };
    const remoteVersion = typeof payload?.version === 'string' ? payload.version.trim() : '';
    if (remoteVersion && remoteVersion !== currentVersion) {
      await applyNewDeployReload(remoteVersion, swRegistration);
    }
  } catch {
    // Offline or local dev server without /version.json
  }
}

// Register Offline-First PWA Service Worker in production web & clear old deploy caches automatically
if ('serviceWorker' in navigator) {
  const isCapacitorNative = !!(window as any).Capacitor?.isNativePlatform?.();
  if (import.meta.env.PROD && !isCapacitorNative) {
    const currentVersion = getAppVersion();
    const expectedCache = `${APP_SHELL_CACHE_PREFIX}${currentVersion}`;
    try {
      const prevVersion = localStorage.getItem(DEPLOYED_VERSION_KEY);
      if (prevVersion && prevVersion !== currentVersion) {
        void clearStaleAppShellCaches(expectedCache);
      }
      localStorage.setItem(DEPLOYED_VERSION_KEY, currentVersion);
    } catch {
      // Ignore storage errors
    }

    let swReg: ServiceWorkerRegistration | null = null;
    let lastCheckMs = 0;
    let refreshingFromSw = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshingFromSw) return;
      refreshingFromSw = true;
      void clearStaleAppShellCaches(expectedCache).finally(() => {
        window.location.reload();
      });
    });

    window.addEventListener('load', () => {
      lastCheckMs = Date.now();
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          swReg = reg;
          void reg.update().catch(() => {});
          void checkRemoteDeployVersion(currentVersion, reg);
        })
        .catch((err) => {
          console.warn('Service worker registration skipped:', err);
          void checkRemoteDeployVersion(currentVersion, null);
        });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastCheckMs < VERSION_CHECK_THROTTLE_MS) return;
      lastCheckMs = now;
      void swReg?.update().catch(() => {});
      void checkRemoteDeployVersion(currentVersion, swReg);
    });
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const reg of registrations) {
        reg.unregister();
      }
    });
  }
}

interface ErrorBoundaryState {
  errorMessage: string | null;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { errorMessage: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'שגיאה לא צפויה בטעינת המסך';
    return { errorMessage: msg };
  }

  componentDidCatch(error: unknown) {
    console.error('[NavApp] Uncaught UI error:', error);
  }

  render() {
    if (this.state.errorMessage) {
      return (
        <div
          dir="rtl"
          className="w-screen h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 text-center gap-4"
        >
          <div className="text-base font-bold text-rose-400">
            אירעה שגיאה בלתי צפויה באפליקציה
          </div>
          <div className="text-xs text-slate-400 max-w-md break-words" dir="ltr">
            {this.state.errorMessage}
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold"
          >
            טען אפליקציה מחדש
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
