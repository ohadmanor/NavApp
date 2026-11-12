import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAppVersion } from '../appVersion';
import {
  DEFAULT_STARTUP_CAMERA,
  USER_STATE_STORAGE_KEY,
  UserStateSyncService,
  mergeUserStates,
  sanitizeCamera,
  type PersistedUserState,
} from '../preferences/UserStateSyncService';
import { DEFAULT_LAYER_VISIBILITY } from '../style/israelOutdoorStyle';
import { BUILT_IN_USER_ICONS } from '../navigation/UserLocationIconService';
import { isCapacitorNativePlatform } from '../firebase/AuthService';

function createMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

describe('Versioning, Google Account UI & Cross-Platform User State Persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('formats app version as x.y.z.<date&time> starting at 0.5.0 and displays it at the bottom of LayerSwitcherSheet', () => {
    const version = getAppVersion();
    expect(version).toMatch(/^0\.5\.0\.\d{8}-\d{4}$/);

    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    expect(pkg.version).toBe('0.5.0');

    const gradle = fs.readFileSync('android/app/build.gradle', 'utf-8');
    expect(gradle).toContain('versionName "0.5.0"');

    const layerSheetSrc = fs.readFileSync('src/components/map/LayerSwitcherSheet.tsx', 'utf-8');
    expect(layerSheetSrc).toContain('getAppVersion()');
    expect(layerSheetSrc).toContain('data-testid="app-version"');
  });

  it('persists and restores last map position, zoom, bearing, pitch, and user configuration locally', () => {
    const memStorage = createMemoryLocalStorage();
    vi.stubGlobal('window', { localStorage: memStorage });

    const fresh = UserStateSyncService.getStartupState();
    expect(fresh.hasSavedCamera).toBe(false);
    expect(fresh.camera).toEqual(DEFAULT_STARTUP_CAMERA);
    expect(DEFAULT_STARTUP_CAMERA.lon).toBeCloseTo(34.996694, 5);
    expect(DEFAULT_STARTUP_CAMERA.lat).toBeCloseTo(31.915028, 5);
    expect(DEFAULT_STARTUP_CAMERA.zoom).toBeCloseTo(9.99, 2);
    expect(fresh.config.theme).toBe('topo-day');
    expect(fresh.config.visibility.googleSatellite).toBe(false);

    UserStateSyncService.recordLocalCamera({
      lon: 35.2137,
      lat: 31.7683,
      zoom: 14.35,
      bearing: 27.4,
      pitch: 45,
    });

    UserStateSyncService.recordLocalConfig({
      theme: 'topo-dark',
      showCenterCrosshair: true,
      planningMode: 'foot',
      navOrientation: 'north-up',
      visibility: {
        ...DEFAULT_LAYER_VISIBILITY,
        googleSatellite: true,
        cycleways: true,
        poiPeaks: false,
      },
      userIcon: {
        icon: BUILT_IN_USER_ICONS[1],
        accentColor: '#10b981',
      },
    });

    // Simulate closing and reopening the app cleanly from storage
    const restored = UserStateSyncService.getStartupState();
    expect(restored.hasSavedCamera).toBe(true);
    expect(restored.camera).toEqual({
      lon: 35.2137,
      lat: 31.7683,
      zoom: 14.35,
      bearing: 27.4,
      pitch: 45,
    });
    expect(restored.config.theme).toBe('topo-dark');
    expect(restored.config.showCenterCrosshair).toBe(true);
    expect(restored.config.planningMode).toBe('foot');
    expect(restored.config.navOrientation).toBe('north-up');
    expect(restored.config.visibility.googleSatellite).toBe(true);
    expect(restored.config.visibility.cycleways).toBe(true);
    expect(restored.config.visibility.poiPeaks).toBe(false);
    expect(restored.config.userIcon.icon.id).toBe(BUILT_IN_USER_ICONS[1].id);
    expect(restored.config.userIcon.accentColor).toBe('#10b981');

    // Corrupted localStorage falls back safely without throwing
    memStorage.setItem(USER_STATE_STORAGE_KEY, '{not-json');
    const fallback = UserStateSyncService.getStartupState();
    expect(fallback.hasSavedCamera).toBe(false);
    expect(fallback.camera).toEqual(DEFAULT_STARTUP_CAMERA);
  });

  it('rejects out-of-range or NaN camera coordinates cleanly', () => {
    expect(
      sanitizeCamera({ lon: Number.NaN, lat: 31, zoom: 12, bearing: 0, pitch: 0 })
    ).toBeNull();
    expect(sanitizeCamera({ lon: 220, lat: 31, zoom: 12, bearing: 0, pitch: 0 })).toBeNull();
    expect(sanitizeCamera({ lon: 35, lat: 95, zoom: 12, bearing: 0, pitch: 0 })).toBeNull();
  });

  it('merges cross-platform cloud state using last-write-wins per section (camera & config)', () => {
    const emptyLocal: PersistedUserState = {
      version: 1,
      camera: null,
      cameraUpdatedAt: 0,
      config: {
        theme: 'topo-day',
        visibility: { ...DEFAULT_LAYER_VISIBILITY },
        navOrientation: 'heading-up',
        showCenterCrosshair: false,
        planningMode: '4x4',
        userIcon: { icon: BUILT_IN_USER_ICONS[0], accentColor: '#0ea5e9' },
      },
      configUpdatedAt: 0,
      lastUpdatedByDeviceId: 'android-1',
    };

    const webRemote: Partial<PersistedUserState> = {
      version: 1,
      camera: { lon: 35.75, lat: 33.05, zoom: 13.8, bearing: 0, pitch: 0 },
      cameraUpdatedAt: 2000,
      config: {
        theme: 'topo-dark',
        visibility: { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true },
        navOrientation: 'north-up',
        showCenterCrosshair: true,
        planningMode: 'bicycle',
        userIcon: { icon: BUILT_IN_USER_ICONS[2], accentColor: '#f59e0b' },
      },
      configUpdatedAt: 2500,
      lastUpdatedByDeviceId: 'web-desktop-1',
      lastSyncedAt: '2026-11-12T09:00:00.000Z',
    };

    // Case 1: Fresh Android sign-in pulls newer Web position and configuration
    const freshPull = mergeUserStates(emptyLocal, webRemote, 'android-1');
    expect(freshPull.applyRemoteCamera).toBe(true);
    expect(freshPull.applyRemoteConfig).toBe(true);
    expect(freshPull.shouldPushCloud).toBe(false);
    expect(freshPull.merged.camera?.lon).toBe(35.75);
    expect(freshPull.merged.config.theme).toBe('topo-dark');
    expect(freshPull.merged.config.planningMode).toBe('bicycle');

    // Case 2: Device edited camera offline later (t=5000 > 2000), while config stays from cloud (t=1000 < 2500)
    const offlineEdited: PersistedUserState = {
      ...emptyLocal,
      camera: { lon: 34.91, lat: 30.61, zoom: 15.1, bearing: 15, pitch: 0 },
      cameraUpdatedAt: 5000,
      configUpdatedAt: 1000,
      lastUpdatedByDeviceId: 'android-1',
    };
    const hybridMerge = mergeUserStates(offlineEdited, webRemote, 'android-1');
    expect(hybridMerge.applyRemoteCamera).toBe(false);
    expect(hybridMerge.applyRemoteConfig).toBe(true);
    expect(hybridMerge.shouldPushCloud).toBe(true);
    expect(hybridMerge.merged.camera?.lon).toBe(34.91);
    expect(hybridMerge.merged.config.theme).toBe('topo-dark');
  });

  it('places Google account button below My Position on both Desktop and Mobile and permits settings sync in firestore.rules', () => {
    const appSrc = fs.readFileSync('src/App.tsx', 'utf-8');
    expect(appSrc).toContain('<GoogleAccountButton');
    const desktopLocateIdx = appSrc.indexOf('onClick={handleLocateMe}');
    const desktopGoogleIdx = appSrc.indexOf('<GoogleAccountButton', desktopLocateIdx);
    expect(desktopLocateIdx).toBeGreaterThan(-1);
    expect(desktopGoogleIdx).toBeGreaterThan(desktopLocateIdx);

    const mobileLocateIdx = appSrc.indexOf('onClick={handleLocateMe}', desktopGoogleIdx);
    const mobileGoogleIdx = appSrc.indexOf('<GoogleAccountButton', mobileLocateIdx);
    expect(mobileLocateIdx).toBeGreaterThan(desktopGoogleIdx);
    expect(mobileGoogleIdx).toBeGreaterThan(mobileLocateIdx);

    const rules = fs.readFileSync('firestore.rules', 'utf-8');
    expect(rules).toContain('/planing_tracks/{userId}/settings/{settingId}');
  });

  it('configures Android WebView multi-window OAuth popup handling without navigating main WebView to blank handler', () => {
    vi.stubGlobal('window', {});
    expect(isCapacitorNativePlatform()).toBe(false);
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
    expect(isCapacitorNativePlatform()).toBe(true);

    const mainActivitySrc = fs.readFileSync(
      'android/app/src/main/java/com/navapp/outdoor/israel/MainActivity.java',
      'utf-8'
    );
    expect(mainActivitySrc).toContain('setSupportMultipleWindows(true)');
    expect(mainActivitySrc).toContain('setAcceptThirdPartyCookies');
    expect(mainActivitySrc).toContain('new NavAppWebChromeClient');

    const chromeClientSrc = fs.readFileSync(
      'android/app/src/main/java/com/navapp/outdoor/israel/NavAppWebChromeClient.java',
      'utf-8'
    );
    expect(chromeClientSrc).toContain('onCreateWindow');
    expect(chromeClientSrc).toContain('onCloseWindow');
    expect(chromeClientSrc).toContain('WebViewTransport');
  });
});
