import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Register Offline-First PWA Service Worker in production web; unregister stale SWs in dev or native Capacitor
if ('serviceWorker' in navigator) {
  const isCapacitorNative = !!(window as any).Capacitor?.isNativePlatform?.();
  if (import.meta.env.PROD && !isCapacitorNative) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration skipped:', err);
      });
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
