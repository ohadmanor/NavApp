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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

