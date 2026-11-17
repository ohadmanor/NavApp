import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeDurationExpiry,
  haversineMeters,
  isLiveLocationExpired,
  LIVE_LOCATION_MIN_INTERVAL_MS,
  LIVE_LOCATION_MOVEMENT_INTERVAL_MS,
  LiveLocationCloudService,
  loadPersistedShareConfig,
  resetLiveLocationSessionForTesting,
  savePersistedShareConfig,
  shouldPublishLiveFix,
  type LiveLocationShareConfig,
} from '../firebase/LiveLocationCloudService';
import type { LiveGpsFix } from '../navigation/LiveGpsService';
import * as firebaseApp from '../firebase/firebaseApp';
import { setDoc } from 'firebase/firestore';

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn((_fs, col, id) => ({ col, id })),
  onSnapshot: vi.fn(() => () => {}),
  query: vi.fn(() => ({})),
  setDoc: vi.fn(async () => {}),
  where: vi.fn(() => ({})),
}));

function makeFix(lon = 35.15, lat = 31.78): LiveGpsFix {
  return {
    lon,
    lat,
    accuracy: 5,
    altitude: 500,
    heading: 90,
    speed: 3.5,
    timestamp: 1700000000000,
  };
}

describe('LiveLocationCloudService helpers', () => {
  beforeEach(() => {
    resetLiveLocationSessionForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes expiry timestamps for duration presets', () => {
    const now = 1_700_000_000_000;
    const oneH = computeDurationExpiry('1h', now);
    expect(oneH.expiresAtMs).toBe(now + 3600 * 1000);
    expect(oneH.expiresAt).toBe(new Date(now + 3600 * 1000).toISOString());

    const fourH = computeDurationExpiry('4h', now);
    expect(fourH.expiresAtMs).toBe(now + 4 * 3600 * 1000);

    const forever = computeDurationExpiry('forever', now);
    expect(forever.expiresAtMs).toBeNull();
    expect(forever.expiresAt).toBeNull();
  });

  it('computes haversine distance accurately', () => {
    const same = haversineMeters(35.15, 31.78, 35.15, 31.78);
    expect(same).toBe(0);

    // ~0.001 deg lat is ~111m
    const moved = haversineMeters(35.15, 31.78, 35.15, 31.781);
    expect(moved).toBeGreaterThan(100);
    expect(moved).toBeLessThan(125);
  });

  it('detects expired or inactive records', () => {
    const now = 1_700_000_000_000;
    expect(isLiveLocationExpired({ active: false, expiresAtMs: null }, now)).toBe(true);
    expect(isLiveLocationExpired({ active: true, expiresAtMs: null }, now)).toBe(false);
    expect(isLiveLocationExpired({ active: true, expiresAtMs: now - 1 }, now)).toBe(true);
    expect(isLiveLocationExpired({ active: true, expiresAtMs: now + 10000 }, now)).toBe(false);
  });

  it('throttles publishes by time, movement distance, and signature', async () => {
    vi.spyOn(firebaseApp, 'getFirebaseServices').mockReturnValue({
      app: {} as any,
      firestore: {} as any,
      auth: {} as any,
      storage: {} as any,
      googleProvider: {} as any,
    });

    const user = {
      uid: 'u1',
      email: 'u1@example.com',
      displayName: 'User One',
      photoURL: null,
    };
    const config: LiveLocationShareConfig = {
      visibility: 'public',
      sharedWith: [],
      durationPreset: '1h',
      startedAt: '2026-11-17T10:00:00.000Z',
      expiresAt: null,
      expiresAtMs: null,
    };
    const iconPref = {
      icon: { id: 'car-4wd', labelHe: '4x4', category: 'vehicles' as const },
      accentColor: '#0ea5e9',
    };

    const sig = 'public|||car-4wd|#0ea5e9|forever';
    expect(shouldPublishLiveFix('u1', makeFix(), sig, 1000)).toBe(true);

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await LiveLocationCloudService.publishNow(user, config, makeFix(35.15, 31.78), iconPref);
    expect(setDoc).toHaveBeenCalledTimes(1);

    // Within 3s, same signature, no movement -> throttled
    expect(shouldPublishLiveFix('u1', makeFix(35.15, 31.78), sig, 2000)).toBe(false);

    // After movement interval (3s) + >25m movement -> publish
    expect(
      shouldPublishLiveFix(
        'u1',
        makeFix(35.15, 31.7805),
        sig,
        1000 + LIVE_LOCATION_MOVEMENT_INTERVAL_MS
      )
    ).toBe(true);

    // After min interval (8s) even without movement -> publish
    expect(
      shouldPublishLiveFix('u1', makeFix(35.15, 31.78), sig, 1000 + LIVE_LOCATION_MIN_INTERVAL_MS)
    ).toBe(true);

    // Signature change -> immediate publish
    expect(shouldPublishLiveFix('u1', makeFix(35.15, 31.78), 'changed-sig', 1500)).toBe(true);

    nowSpy.mockRestore();
  });

  it('persists and auto-clears expired share configs in localStorage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });

    const activeConfig: LiveLocationShareConfig = {
      visibility: 'public',
      sharedWith: [],
      durationPreset: '1h',
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expiresAtMs: Date.now() + 60_000,
    };
    savePersistedShareConfig('u1', activeConfig);
    expect(loadPersistedShareConfig('u1')?.visibility).toBe('public');

    const expiredConfig: LiveLocationShareConfig = {
      ...activeConfig,
      expiresAtMs: Date.now() - 1000,
    };
    savePersistedShareConfig('u1', expiredConfig);
    expect(loadPersistedShareConfig('u1')).toBeNull();

    vi.unstubAllGlobals();
  });
});
