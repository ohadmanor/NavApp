import {
  collection,
  doc,
  onSnapshot,
  query,
  setDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import type { PoiShareRecipient } from '../db/NavDatabase';
import type { LiveGpsFix } from '../navigation/LiveGpsService';
import type { UserLocationIconPreference } from '../navigation/UserLocationIconService';
import type { NavUser } from './AuthService';
import { getFirebaseServices } from './firebaseApp';

export const LIVE_LOCATIONS_COLLECTION = 'live_locations';
export const LIVE_LOCATION_STORAGE_KEY_PREFIX = 'navapp.liveLocationShare.v1.';

export type LiveLocationVisibility = 'off' | 'shared' | 'public';
export type LiveLocationDurationPreset = '1h' | '4h' | '8h' | 'forever';

export const LIVE_LOCATION_MIN_INTERVAL_MS = 8000;
export const LIVE_LOCATION_MOVEMENT_INTERVAL_MS = 3000;
export const LIVE_LOCATION_MOVEMENT_THRESHOLD_M = 25;
export const LIVE_LOCATION_EXPIRY_SWEEP_MS = 30000;

export interface LiveLocationShareConfig {
  visibility: LiveLocationVisibility;
  sharedWith: PoiShareRecipient[];
  durationPreset: LiveLocationDurationPreset;
  startedAt: string;
  expiresAt: string | null;
  expiresAtMs: number | null;
}

export interface LiveLocationRecord {
  uid: string;
  displayName: string;
  email: string | null;
  photoURL: string | null;
  visibility: LiveLocationVisibility;
  active: boolean;
  sharedWith: PoiShareRecipient[];
  sharedWithUids: string[];
  sharedWithEmails: string[];
  lon: number;
  lat: number;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  iconId: string;
  accentColor: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string | null;
  expiresAtMs: number | null;
}

interface PublishThrottleState {
  lastPublishedAtMs: number;
  lastLon: number;
  lastLat: number;
  lastSignature: string;
}

const publishThrottleByUid = new Map<string, PublishThrottleState>();

export function resetLiveLocationSessionForTesting(): void {
  publishThrottleByUid.clear();
}

export function computeDurationExpiry(
  preset: LiveLocationDurationPreset,
  nowMs = Date.now()
): { expiresAt: string | null; expiresAtMs: number | null } {
  const hoursMap: Record<Exclude<LiveLocationDurationPreset, 'forever'>, number> = {
    '1h': 1,
    '4h': 4,
    '8h': 8,
  };
  if (preset === 'forever') {
    return { expiresAt: null, expiresAtMs: null };
  }
  const expiresAtMs = nowMs + hoursMap[preset] * 60 * 60 * 1000;
  return {
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
  };
}

export function haversineMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isLiveLocationExpired(
  record: Pick<LiveLocationRecord, 'expiresAtMs' | 'active'>,
  nowMs = Date.now()
): boolean {
  if (!record.active) return true;
  if (typeof record.expiresAtMs === 'number' && Number.isFinite(record.expiresAtMs)) {
    return record.expiresAtMs <= nowMs;
  }
  return false;
}

export function shouldPublishLiveFix(
  uid: string,
  fix: LiveGpsFix,
  signature: string,
  nowMs = Date.now()
): boolean {
  const prev = publishThrottleByUid.get(uid);
  if (!prev) return true;
  if (prev.lastSignature !== signature) return true;
  const elapsed = nowMs - prev.lastPublishedAtMs;
  if (elapsed >= LIVE_LOCATION_MIN_INTERVAL_MS) return true;
  if (elapsed >= LIVE_LOCATION_MOVEMENT_INTERVAL_MS) {
    const dist = haversineMeters(prev.lastLon, prev.lastLat, fix.lon, fix.lat);
    if (dist >= LIVE_LOCATION_MOVEMENT_THRESHOLD_M) return true;
  }
  return false;
}

export function loadPersistedShareConfig(uid: string): LiveLocationShareConfig | null {
  if (!uid || typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(`${LIVE_LOCATION_STORAGE_KEY_PREFIX}${uid}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LiveLocationShareConfig;
    if (!parsed || parsed.visibility === 'off') return null;
    if (
      typeof parsed.expiresAtMs === 'number' &&
      Number.isFinite(parsed.expiresAtMs) &&
      parsed.expiresAtMs <= Date.now()
    ) {
      window.localStorage.removeItem(`${LIVE_LOCATION_STORAGE_KEY_PREFIX}${uid}`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function savePersistedShareConfig(
  uid: string,
  config: LiveLocationShareConfig | null
): void {
  if (!uid || typeof window === 'undefined' || !window.localStorage) return;
  const key = `${LIVE_LOCATION_STORAGE_KEY_PREFIX}${uid}`;
  try {
    if (!config || config.visibility === 'off') {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(config));
  } catch {
    // Ignore storage quota errors
  }
}

function normalizeRecipients(sharedWith: PoiShareRecipient[]): {
  sharedWith: PoiShareRecipient[];
  sharedWithUids: string[];
  sharedWithEmails: string[];
} {
  const clean: PoiShareRecipient[] = [];
  const uids = new Set<string>();
  const emails = new Set<string>();

  for (const r of sharedWith.slice(0, 50)) {
    const email = (r.email || '').trim().toLowerCase();
    const uid = r.uid ? String(r.uid).trim() : null;
    if (!uid && !email) continue;
    if (uid) uids.add(uid);
    if (email) emails.add(email);
    clean.push({
      uid,
      email,
      displayName: r.displayName ?? null,
      photoURL: r.photoURL ?? null,
      sharedAt: r.sharedAt || new Date().toISOString(),
    });
  }

  return {
    sharedWith: clean,
    sharedWithUids: Array.from(uids),
    sharedWithEmails: Array.from(emails),
  };
}

function mapDocToLiveLocation(raw: Record<string, any>): LiveLocationRecord | null {
  if (!raw || typeof raw.uid !== 'string' || !raw.uid) return null;
  const lon = Number(raw.lon);
  const lat = Number(raw.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const visibility: LiveLocationVisibility =
    raw.visibility === 'public' || raw.visibility === 'shared' ? raw.visibility : 'off';
  return {
    uid: raw.uid,
    displayName:
      typeof raw.displayName === 'string' && raw.displayName.trim()
        ? raw.displayName.trim()
        : 'משתמש NavApp',
    email: typeof raw.email === 'string' ? raw.email : null,
    photoURL: typeof raw.photoURL === 'string' ? raw.photoURL : null,
    visibility,
    active: Boolean(raw.active),
    sharedWith: Array.isArray(raw.sharedWith) ? raw.sharedWith : [],
    sharedWithUids: Array.isArray(raw.sharedWithUids) ? raw.sharedWithUids.map(String) : [],
    sharedWithEmails: Array.isArray(raw.sharedWithEmails) ? raw.sharedWithEmails.map(String) : [],
    lon,
    lat,
    accuracy: typeof raw.accuracy === 'number' && Number.isFinite(raw.accuracy) ? raw.accuracy : null,
    altitude: typeof raw.altitude === 'number' && Number.isFinite(raw.altitude) ? raw.altitude : null,
    heading: typeof raw.heading === 'number' && Number.isFinite(raw.heading) ? raw.heading : null,
    speed: typeof raw.speed === 'number' && Number.isFinite(raw.speed) ? raw.speed : null,
    iconId: typeof raw.iconId === 'string' && raw.iconId ? raw.iconId : 'gps-puck',
    accentColor:
      typeof raw.accentColor === 'string' && raw.accentColor ? raw.accentColor : '#0ea5e9',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    expiresAtMs:
      typeof raw.expiresAtMs === 'number' && Number.isFinite(raw.expiresAtMs)
        ? raw.expiresAtMs
        : null,
  };
}

function buildLiveLocationRecord(
  user: NavUser,
  config: LiveLocationShareConfig,
  fix: LiveGpsFix,
  iconPref: UserLocationIconPreference,
  active: boolean,
  nowMs = Date.now()
): LiveLocationRecord {
  const { sharedWith, sharedWithUids, sharedWithEmails } =
    config.visibility === 'shared'
      ? normalizeRecipients(config.sharedWith)
      : { sharedWith: [], sharedWithUids: [], sharedWithEmails: [] };

  const displayName =
    (user.displayName || (user.email ? user.email.split('@')[0] : '') || 'משתמש NavApp').trim();

  return {
    uid: user.uid,
    displayName: displayName.slice(0, 200),
    email: user.email ? user.email.trim().toLowerCase() : null,
    photoURL: user.photoURL || null,
    visibility: active ? config.visibility : 'off',
    active,
    sharedWith,
    sharedWithUids,
    sharedWithEmails,
    lon: fix.lon,
    lat: fix.lat,
    accuracy: fix.accuracy,
    altitude: fix.altitude,
    heading: fix.heading,
    speed: fix.speed,
    iconId: iconPref.icon.id || 'gps-puck',
    accentColor: iconPref.accentColor || '#0ea5e9',
    startedAt: config.startedAt,
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: config.expiresAt,
    expiresAtMs: config.expiresAtMs,
  };
}

export class LiveLocationCloudService {
  static async publishNow(
    user: NavUser,
    config: LiveLocationShareConfig,
    fix: LiveGpsFix,
    iconPref: UserLocationIconPreference
  ): Promise<boolean> {
    if (!user?.uid || config.visibility === 'off') return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

    const services = getFirebaseServices();
    if (!services) return false;

    const nowMs = Date.now();
    const record = buildLiveLocationRecord(user, config, fix, iconPref, true, nowMs);
    const signature = `${config.visibility}|${record.sharedWithUids.join(',')}|${record.sharedWithEmails.join(',')}|${record.iconId}|${record.accentColor}|${record.expiresAtMs ?? 'forever'}`;

    try {
      await setDoc(doc(services.firestore, LIVE_LOCATIONS_COLLECTION, user.uid), record);
      publishThrottleByUid.set(user.uid, {
        lastPublishedAtMs: nowMs,
        lastLon: fix.lon,
        lastLat: fix.lat,
        lastSignature: signature,
      });
      return true;
    } catch (err) {
      console.warn('[LiveLocationCloudService] publishNow failed:', err);
      return false;
    }
  }

  static async publishFixIfNeeded(
    user: NavUser,
    config: LiveLocationShareConfig,
    fix: LiveGpsFix,
    iconPref: UserLocationIconPreference,
    onExpired?: () => void
  ): Promise<boolean> {
    if (!user?.uid || config.visibility === 'off') return false;
    const nowMs = Date.now();
    if (
      typeof config.expiresAtMs === 'number' &&
      Number.isFinite(config.expiresAtMs) &&
      config.expiresAtMs <= nowMs
    ) {
      await this.stopSharing(user, fix, iconPref);
      onExpired?.();
      return false;
    }

    const { sharedWithUids, sharedWithEmails } =
      config.visibility === 'shared'
        ? normalizeRecipients(config.sharedWith)
        : { sharedWithUids: [], sharedWithEmails: [] };
    const signature = `${config.visibility}|${sharedWithUids.join(',')}|${sharedWithEmails.join(',')}|${iconPref.icon.id}|${iconPref.accentColor}|${config.expiresAtMs ?? 'forever'}`;

    if (!shouldPublishLiveFix(user.uid, fix, signature, nowMs)) {
      return false;
    }
    return this.publishNow(user, config, fix, iconPref);
  }

  static async stopSharing(
    user: NavUser,
    lastFix?: LiveGpsFix | null,
    iconPref?: UserLocationIconPreference
  ): Promise<boolean> {
    if (!user?.uid) return false;
    savePersistedShareConfig(user.uid, null);
    publishThrottleByUid.delete(user.uid);

    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    const services = getFirebaseServices();
    if (!services) return false;

    const fallbackFix: LiveGpsFix = lastFix ?? {
      lon: 35.2,
      lat: 31.8,
      accuracy: null,
      altitude: null,
      heading: null,
      speed: null,
      timestamp: Date.now(),
    };
    const fallbackIcon: UserLocationIconPreference = iconPref ?? {
      icon: { id: 'gps-puck', labelHe: 'נקודת GPS', category: 'default' },
      accentColor: '#0ea5e9',
    };
    const offConfig: LiveLocationShareConfig = {
      visibility: 'off',
      sharedWith: [],
      durationPreset: 'forever',
      startedAt: new Date().toISOString(),
      expiresAt: null,
      expiresAtMs: null,
    };

    try {
      const record = buildLiveLocationRecord(user, offConfig, fallbackFix, fallbackIcon, false);
      await setDoc(doc(services.firestore, LIVE_LOCATIONS_COLLECTION, user.uid), record);
      return true;
    } catch (err) {
      console.warn('[LiveLocationCloudService] stopSharing failed:', err);
      return false;
    }
  }

  static subscribeLiveLocations(
    currentUser: NavUser | null,
    options: { includePublic: boolean },
    onPeersChange: (peers: LiveLocationRecord[]) => void,
    onError?: (err: unknown) => void
  ): () => void {
    const services = getFirebaseServices();
    if (!services || !currentUser?.uid) {
      onPeersChange([]);
      return () => {};
    }

    const colRef = collection(services.firestore, LIVE_LOCATIONS_COLLECTION);
    const buckets = {
      uids: new Map<string, LiveLocationRecord>(),
      emails: new Map<string, LiveLocationRecord>(),
      public: new Map<string, LiveLocationRecord>(),
    };

    const emitMerged = () => {
      const nowMs = Date.now();
      const merged = new Map<string, LiveLocationRecord>();
      const sources = options.includePublic
        ? [buckets.public, buckets.emails, buckets.uids]
        : [buckets.emails, buckets.uids];

      for (const map of sources) {
        for (const [uid, rec] of map.entries()) {
          if (uid === currentUser.uid) continue;
          if (isLiveLocationExpired(rec, nowMs)) continue;
          merged.set(uid, rec);
        }
      }

      const list = Array.from(merged.values()).sort((a, b) =>
        a.displayName.localeCompare(b.displayName, 'he')
      );
      onPeersChange(list);
    };

    const unsubs: Unsubscribe[] = [];

    const attachQuery = (
      bucketKey: keyof typeof buckets,
      q: ReturnType<typeof query>
    ) => {
      const unsub = onSnapshot(
        q,
        (snap) => {
          const next = new Map<string, LiveLocationRecord>();
          snap.forEach((docSnap) => {
            const mapped = mapDocToLiveLocation(docSnap.data() as Record<string, any>);
            if (mapped) {
              next.set(mapped.uid, mapped);
            }
          });
          buckets[bucketKey] = next;
          emitMerged();
        },
        (err) => {
          console.warn(`[LiveLocationCloudService] ${bucketKey} snapshot error:`, err);
          onError?.(err);
        }
      );
      unsubs.push(unsub);
    };

    attachQuery(
      'uids',
      query(colRef, where('sharedWithUids', 'array-contains', currentUser.uid))
    );

    const emailLower = (currentUser.email || '').trim().toLowerCase();
    if (emailLower) {
      attachQuery(
        'emails',
        query(colRef, where('sharedWithEmails', 'array-contains', emailLower))
      );
    }

    if (options.includePublic) {
      attachQuery(
        'public',
        query(colRef, where('visibility', '==', 'public'))
      );
    }

    const sweepTimer = window.setInterval(() => {
      emitMerged();
    }, LIVE_LOCATION_EXPIRY_SWEEP_MS);

    return () => {
      window.clearInterval(sweepTimer);
      unsubs.forEach((u) => u());
    };
  }
}
