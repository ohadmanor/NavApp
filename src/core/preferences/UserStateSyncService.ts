import { doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import type { NavUser } from '../firebase/AuthService';
import { getFirebaseServices } from '../firebase/firebaseApp';
import {
  DEFAULT_NAV_ORIENTATION,
  NavigationHeadingService,
  type MapNavigationOrientation,
} from '../navigation/NavigationHeadingService';
import {
  UserLocationIconService,
  type UserLocationIconPreference,
} from '../navigation/UserLocationIconService';
import type { PlanningMode } from '../routing/RoutingProfiles';
import {
  DEFAULT_LAYER_VISIBILITY,
  type OutdoorLayerVisibility,
} from '../style/israelOutdoorStyle';
import type { MapTheme } from '../../components/ui/themeTokens';
import type { PoiOverrideRecord } from '../db/NavDatabase';
import { isValidPoiCategory, normalizeSubcategoryForCategory } from '../pois/poiTaxonomy';

export interface SavedMapCamera {
  lon: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface SavedUserConfiguration {
  theme: MapTheme;
  visibility: OutdoorLayerVisibility;
  navOrientation: MapNavigationOrientation;
  showCenterCrosshair: boolean;
  planningMode: PlanningMode;
  userIcon: UserLocationIconPreference;
}

export interface PersistedUserState {
  version: 1;
  camera: SavedMapCamera | null;
  cameraUpdatedAt: number;
  config: SavedUserConfiguration;
  configUpdatedAt: number;
  poiOverrides?: PoiOverrideRecord[];
  poiOverridesUpdatedAt?: number;
  lastUpdatedByDeviceId: string;
  lastSyncedAt?: string;
}

export interface MergeUserStateResult {
  merged: PersistedUserState;
  applyRemoteCamera: boolean;
  applyRemoteConfig: boolean;
  applyRemotePoiOverrides: boolean;
  shouldPushCloud: boolean;
}

// Default startup view captured from http://localhost:5173 (Central Israel: Tel Aviv-Jerusalem corridor, z10)
export const DEFAULT_STARTUP_CAMERA: SavedMapCamera = {
  lon: 34.996694,
  lat: 31.915028,
  zoom: 9.99,
  bearing: 0,
  pitch: 0,
};

export const USER_STATE_STORAGE_KEY = 'navapp.userState.v1';
export const USER_DEVICE_ID_STORAGE_KEY = 'navapp.deviceId.v1';
export const USER_SETTINGS_COLLECTION = 'planing_tracks';
export const USER_SETTINGS_SUBCOLLECTION = 'settings';
export const USER_SETTINGS_DOC_ID = 'app_state';

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 'ssr-device';
  }
  try {
    const existing = window.localStorage.getItem(USER_DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim()) {
      return existing.trim();
    }
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(USER_DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return `dev-${Date.now()}`;
  }
}

export function getDefaultUserConfiguration(): SavedUserConfiguration {
  return {
    theme: 'topo-day',
    visibility: { ...DEFAULT_LAYER_VISIBILITY },
    navOrientation: NavigationHeadingService.getOrientationPreference() || DEFAULT_NAV_ORIENTATION,
    showCenterCrosshair: false,
    planningMode: '4x4',
    userIcon: UserLocationIconService.getPreference(),
  };
}

export function sanitizeCamera(raw: unknown): SavedMapCamera | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<SavedMapCamera>;
  if (
    typeof c.lon !== 'number' ||
    typeof c.lat !== 'number' ||
    typeof c.zoom !== 'number' ||
    !Number.isFinite(c.lon) ||
    !Number.isFinite(c.lat) ||
    !Number.isFinite(c.zoom)
  ) {
    return null;
  }
  if (c.lon < -180 || c.lon > 180 || c.lat < -85 || c.lat > 85 || c.zoom < 0 || c.zoom > 22) {
    return null;
  }
  const bearing =
    typeof c.bearing === 'number' && Number.isFinite(c.bearing)
      ? Number((((c.bearing % 360) + 540) % 360 - 180).toFixed(1))
      : 0;
  const pitch =
    typeof c.pitch === 'number' && Number.isFinite(c.pitch)
      ? Number(Math.min(85, Math.max(0, c.pitch)).toFixed(1))
      : 0;

  return {
    lon: Number(c.lon.toFixed(6)),
    lat: Number(c.lat.toFixed(6)),
    zoom: Number(c.zoom.toFixed(2)),
    bearing,
    pitch,
  };
}

export function sanitizeVisibility(raw: unknown): OutdoorLayerVisibility {
  const base = { ...DEFAULT_LAYER_VISIBILITY };
  if (!raw || typeof raw !== 'object') return base;
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(base) as Array<keyof OutdoorLayerVisibility>) {
    if (typeof rec[key] === 'boolean') {
      base[key] = rec[key] as boolean;
    }
  }
  return base;
}

export function sanitizeUserIconPreference(
  raw: unknown,
  fallback: UserLocationIconPreference
): UserLocationIconPreference {
  if (!raw || typeof raw !== 'object') return fallback;
  const rec = raw as Partial<UserLocationIconPreference>;
  if (!rec.icon || typeof rec.icon.id !== 'string' || !rec.icon.id.trim()) {
    return fallback;
  }
  const safeInlineSvg =
    typeof rec.icon.inlineSvg === 'string' && rec.icon.inlineSvg.length <= 32768
      ? rec.icon.inlineSvg
      : undefined;
  return {
    icon: {
      id: rec.icon.id.trim(),
      labelHe: String(rec.icon.labelHe || rec.icon.id),
      category: rec.icon.category || 'default',
      svgUrl: typeof rec.icon.svgUrl === 'string' ? rec.icon.svgUrl : undefined,
      inlineSvg: safeInlineSvg,
      rotateWithHeading: Boolean(rec.icon.rotateWithHeading),
    },
    accentColor:
      typeof rec.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(rec.accentColor)
        ? rec.accentColor
        : fallback.accentColor,
  };
}

export function sanitizeUserConfiguration(
  raw: unknown,
  fallback: SavedUserConfiguration = getDefaultUserConfiguration()
): SavedUserConfiguration {
  if (!raw || typeof raw !== 'object') return fallback;
  const rec = raw as Partial<SavedUserConfiguration>;
  const theme: MapTheme =
    rec.theme === 'topo-dark' || rec.theme === 'topo-day' ? rec.theme : fallback.theme;
  const navOrientation: MapNavigationOrientation =
    rec.navOrientation === 'north-up' || rec.navOrientation === 'heading-up'
      ? rec.navOrientation
      : fallback.navOrientation;
  const planningMode: PlanningMode =
    rec.planningMode === '4x4' || rec.planningMode === 'foot' || rec.planningMode === 'bicycle'
      ? rec.planningMode
      : fallback.planningMode;

  return {
    theme,
    visibility: sanitizeVisibility(rec.visibility ?? fallback.visibility),
    navOrientation,
    showCenterCrosshair:
      typeof rec.showCenterCrosshair === 'boolean'
        ? rec.showCenterCrosshair
        : fallback.showCenterCrosshair,
    planningMode,
    userIcon: sanitizeUserIconPreference(rec.userIcon, fallback.userIcon),
  };
}

const MAX_SYNCED_POI_OVERRIDES = 500;

export function sanitizePoiOverrides(raw: unknown): PoiOverrideRecord[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, PoiOverrideRecord>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Partial<PoiOverrideRecord>;
    if (typeof rec.id !== 'string' || !rec.id.trim()) continue;
    if (typeof rec.updatedAt !== 'string' || !rec.updatedAt.trim()) continue;
    const id = rec.id.trim();
    const updatedAt = rec.updatedAt.trim();
    const deleted = typeof rec.deleted === 'boolean' ? rec.deleted : undefined;
    const hasCat = isValidPoiCategory(rec.category);
    if (!deleted && !hasCat) continue;

    const clean: PoiOverrideRecord = {
      id,
      ...(deleted !== undefined ? { deleted } : {}),
      ...(hasCat
        ? {
            category: rec.category,
            subcategory: normalizeSubcategoryForCategory(rec.category!, rec.subcategory),
          }
        : {}),
      updatedAt,
    };
    const prev = byId.get(id);
    if (!prev || clean.updatedAt >= prev.updatedAt) {
      byId.set(id, clean);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SYNCED_POI_OVERRIDES);
}

function mergePoiOverrideLists(
  localList: PoiOverrideRecord[],
  remoteList: PoiOverrideRecord[]
): {
  merged: PoiOverrideRecord[];
  takeRemote: boolean;
  pushLocal: boolean;
} {
  const localById = new Map(localList.map((r) => [r.id, r]));
  const remoteById = new Map(remoteList.map((r) => [r.id, r]));
  const mergedMap = new Map<string, PoiOverrideRecord>();
  let takeRemote = false;
  let pushLocal = false;

  for (const r of localList) {
    mergedMap.set(r.id, r);
  }
  for (const r of remoteList) {
    const local = localById.get(r.id);
    if (!local) {
      mergedMap.set(r.id, r);
      takeRemote = true;
    } else if (r.updatedAt > local.updatedAt) {
      mergedMap.set(r.id, r);
      takeRemote = true;
    } else if (local.updatedAt > r.updatedAt) {
      pushLocal = true;
    }
  }
  for (const r of localList) {
    if (!remoteById.has(r.id)) {
      pushLocal = true;
    }
  }

  const merged = Array.from(mergedMap.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SYNCED_POI_OVERRIDES);
  return { merged, takeRemote, pushLocal };
}

export function sanitizePersistedUserState(
  raw: unknown,
  fallbackDeviceId = getOrCreateDeviceId()
): PersistedUserState {
  const defaultConfig = getDefaultUserConfiguration();
  if (!raw || typeof raw !== 'object') {
    return {
      version: 1,
      camera: null,
      cameraUpdatedAt: 0,
      config: defaultConfig,
      configUpdatedAt: 0,
      lastUpdatedByDeviceId: fallbackDeviceId,
    };
  }
  const rec = raw as Partial<PersistedUserState>;
  const cam = sanitizeCamera(rec.camera);
  const camTs =
    cam && typeof rec.cameraUpdatedAt === 'number' && Number.isFinite(rec.cameraUpdatedAt)
      ? Math.max(0, rec.cameraUpdatedAt)
      : 0;
  const cfg = sanitizeUserConfiguration(rec.config, defaultConfig);
  const cfgTs =
    typeof rec.configUpdatedAt === 'number' && Number.isFinite(rec.configUpdatedAt)
      ? Math.max(0, rec.configUpdatedAt)
      : 0;
  const poiOverrides = sanitizePoiOverrides(rec.poiOverrides);
  const poiOverridesTs =
    typeof rec.poiOverridesUpdatedAt === 'number' && Number.isFinite(rec.poiOverridesUpdatedAt)
      ? Math.max(0, rec.poiOverridesUpdatedAt)
      : 0;

  return {
    version: 1,
    camera: cam,
    cameraUpdatedAt: camTs,
    config: cfg,
    configUpdatedAt: cfgTs,
    ...(poiOverrides.length > 0 ? { poiOverrides } : {}),
    ...(poiOverridesTs > 0 ? { poiOverridesUpdatedAt: poiOverridesTs } : {}),
    lastUpdatedByDeviceId:
      typeof rec.lastUpdatedByDeviceId === 'string' && rec.lastUpdatedByDeviceId.trim()
        ? rec.lastUpdatedByDeviceId.trim()
        : fallbackDeviceId,
    lastSyncedAt: typeof rec.lastSyncedAt === 'string' ? rec.lastSyncedAt : undefined,
  };
}

/**
 * Pure conflict-resolution merge between local device state and cloud user state.
 * Newer timestamps win independently for camera position, app configuration, and per-POI overrides.
 */
export function mergeUserStates(
  localRaw: PersistedUserState,
  remoteRaw: Partial<PersistedUserState> | null | undefined,
  localDeviceId: string
): MergeUserStateResult {
  const local = sanitizePersistedUserState(localRaw, localDeviceId);
  if (!remoteRaw || typeof remoteRaw !== 'object') {
    const hasLocalData =
      local.cameraUpdatedAt > 0 ||
      local.configUpdatedAt > 0 ||
      (local.poiOverridesUpdatedAt ?? 0) > 0 ||
      (local.poiOverrides?.length ?? 0) > 0;
    return {
      merged: local,
      applyRemoteCamera: false,
      applyRemoteConfig: false,
      applyRemotePoiOverrides: false,
      shouldPushCloud: hasLocalData,
    };
  }

  const remote = sanitizePersistedUserState(remoteRaw, remoteRaw.lastUpdatedByDeviceId || 'remote');
  const fromAnotherDevice = remote.lastUpdatedByDeviceId !== localDeviceId;

  const takeRemoteCamera =
    Boolean(remote.camera) &&
    remote.cameraUpdatedAt > local.cameraUpdatedAt &&
    (local.cameraUpdatedAt === 0 || fromAnotherDevice);

  const takeRemoteConfig =
    remote.configUpdatedAt > local.configUpdatedAt &&
    (local.configUpdatedAt === 0 || fromAnotherDevice);

  const mergedCamera = takeRemoteCamera ? remote.camera : local.camera;
  const mergedCameraTs = takeRemoteCamera ? remote.cameraUpdatedAt : local.cameraUpdatedAt;
  const mergedConfig = takeRemoteConfig ? remote.config : local.config;
  const mergedConfigTs = takeRemoteConfig ? remote.configUpdatedAt : local.configUpdatedAt;

  const ovMerge = mergePoiOverrideLists(local.poiOverrides ?? [], remote.poiOverrides ?? []);
  const localOvTs = local.poiOverridesUpdatedAt ?? 0;
  const remoteOvTs = remote.poiOverridesUpdatedAt ?? 0;
  const mergedOvTs = Math.max(localOvTs, remoteOvTs);
  const takeRemotePoiOverrides =
    ovMerge.takeRemote && (localOvTs === 0 || fromAnotherDevice);

  const shouldPushCloud =
    (local.cameraUpdatedAt > remote.cameraUpdatedAt && Boolean(local.camera)) ||
    local.configUpdatedAt > remote.configUpdatedAt ||
    ovMerge.pushLocal ||
    localOvTs > remoteOvTs;

  return {
    merged: {
      version: 1,
      camera: mergedCamera,
      cameraUpdatedAt: mergedCameraTs,
      config: mergedConfig,
      configUpdatedAt: mergedConfigTs,
      ...(ovMerge.merged.length > 0 ? { poiOverrides: ovMerge.merged } : {}),
      ...(mergedOvTs > 0 ? { poiOverridesUpdatedAt: mergedOvTs } : {}),
      lastUpdatedByDeviceId:
        takeRemoteCamera || takeRemoteConfig || takeRemotePoiOverrides
          ? remote.lastUpdatedByDeviceId
          : localDeviceId,
      lastSyncedAt: remote.lastSyncedAt || local.lastSyncedAt,
    },
    applyRemoteCamera: takeRemoteCamera,
    applyRemoteConfig: takeRemoteConfig,
    applyRemotePoiOverrides: takeRemotePoiOverrides,
    shouldPushCloud,
  };
}

let cloudWriteTimer: number | null = null;
let cloudSyncDirty = false;
let cloudWriteUser: NavUser | null = null;

export class UserStateSyncService {
  static loadLocalState(): PersistedUserState {
    const deviceId = getOrCreateDeviceId();
    if (typeof window === 'undefined' || !window.localStorage) {
      return sanitizePersistedUserState(null, deviceId);
    }
    try {
      const raw = window.localStorage.getItem(USER_STATE_STORAGE_KEY);
      if (!raw) {
        return sanitizePersistedUserState(null, deviceId);
      }
      return sanitizePersistedUserState(JSON.parse(raw), deviceId);
    } catch {
      return sanitizePersistedUserState(null, deviceId);
    }
  }

  static getStartupState(): {
    camera: SavedMapCamera;
    hasSavedCamera: boolean;
    config: SavedUserConfiguration;
    rawState: PersistedUserState;
  } {
    const rawState = this.loadLocalState();
    return {
      camera: rawState.camera ?? { ...DEFAULT_STARTUP_CAMERA },
      hasSavedCamera: Boolean(rawState.camera && rawState.cameraUpdatedAt > 0),
      config: rawState.config,
      rawState,
    };
  }

  static saveLocalState(state: PersistedUserState): PersistedUserState {
    const normalized = sanitizePersistedUserState(state, getOrCreateDeviceId());
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(USER_STATE_STORAGE_KEY, JSON.stringify(normalized));
      } catch {
        // Ignore storage quota restrictions
      }
    }
    return normalized;
  }

  static recordLocalCamera(
    camera: SavedMapCamera,
    user?: NavUser | null,
    debounceMs = 1500
  ): PersistedUserState | null {
    const clean = sanitizeCamera(camera);
    if (!clean) return null;
    const prev = this.loadLocalState();
    const nowTs = Math.max(Date.now(), prev.cameraUpdatedAt + 1);
    const next = this.saveLocalState({
      ...prev,
      camera: clean,
      cameraUpdatedAt: nowTs,
      lastUpdatedByDeviceId: getOrCreateDeviceId(),
    });
    if (user) {
      this.scheduleCloudPush(user, debounceMs);
    }
    return next;
  }

  static recordLocalConfig(
    partialConfig: Partial<SavedUserConfiguration>,
    user?: NavUser | null,
    debounceMs = 450
  ): PersistedUserState {
    const prev = this.loadLocalState();
    const mergedConfig = sanitizeUserConfiguration(
      { ...prev.config, ...partialConfig },
      prev.config
    );
    const nowTs = Math.max(Date.now(), prev.configUpdatedAt + 1);
    const next = this.saveLocalState({
      ...prev,
      config: mergedConfig,
      configUpdatedAt: nowTs,
      lastUpdatedByDeviceId: getOrCreateDeviceId(),
    });
    if (user) {
      this.scheduleCloudPush(user, debounceMs);
    }
    return next;
  }

  static recordLocalPoiOverrides(
    overrides: PoiOverrideRecord[],
    user?: NavUser | null,
    debounceMs = 1000
  ): PersistedUserState {
    const prev = this.loadLocalState();
    const clean = sanitizePoiOverrides(overrides);
    const nowTs = Math.max(Date.now(), (prev.poiOverridesUpdatedAt ?? 0) + 1);
    const next = this.saveLocalState({
      ...prev,
      poiOverrides: clean,
      poiOverridesUpdatedAt: nowTs,
      lastUpdatedByDeviceId: getOrCreateDeviceId(),
    });
    if (user) {
      this.scheduleCloudPush(user, debounceMs);
    }
    return next;
  }

  static cancelScheduledCloudPush(): void {
    if (cloudWriteTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(cloudWriteTimer);
    }
    cloudWriteTimer = null;
  }

  static scheduleCloudPush(user: NavUser, delayMs = 1200): void {
    cloudSyncDirty = true;
    cloudWriteUser = user;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (typeof window === 'undefined') return;
    this.cancelScheduledCloudPush();
    cloudWriteTimer = window.setTimeout(() => {
      cloudWriteTimer = null;
      void this.flushCloudPush(user);
    }, delayMs);
  }

  static async flushCloudPush(user?: NavUser | null): Promise<boolean> {
    const targetUser = user || cloudWriteUser;
    this.cancelScheduledCloudPush();
    if (!targetUser) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    const services = getFirebaseServices();
    if (!services) return false;

    const current = this.loadLocalState();
    if (current.cameraUpdatedAt === 0 && current.configUpdatedAt === 0) {
      cloudSyncDirty = false;
      return false;
    }

    const deviceId = getOrCreateDeviceId();
    const syncedIso = new Date().toISOString();
    const {
      poiOverrides: _omitOverrides,
      poiOverridesUpdatedAt: _omitOverridesTs,
      ...stateWithoutPois
    } = current;
    const payload = stripUndefinedDeep({
      ...stateWithoutPois,
      lastUpdatedByDeviceId: deviceId,
      lastSyncedAt: syncedIso,
      ownerUid: targetUser.uid,
      ownerEmail: targetUser.email || null,
    });

    try {
      const refDoc = doc(
        services.firestore,
        USER_SETTINGS_COLLECTION,
        targetUser.uid,
        USER_SETTINGS_SUBCOLLECTION,
        USER_SETTINGS_DOC_ID
      );
      await setDoc(refDoc, payload, { merge: true });
      cloudSyncDirty = false;
      this.saveLocalState({
        ...current,
        lastUpdatedByDeviceId: deviceId,
        lastSyncedAt: syncedIso,
      });
      return true;
    } catch (err) {
      console.warn('[UserStateSync] Cloud push failed:', err);
      return false;
    }
  }

  static hasDirtyCloudChanges(): boolean {
    return cloudSyncDirty;
  }

  static async pullAndMergeCloudState(user: NavUser): Promise<MergeUserStateResult | null> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
    const services = getFirebaseServices();
    if (!services) return null;

    const local = this.loadLocalState();
    const deviceId = getOrCreateDeviceId();
    const refDoc = doc(
      services.firestore,
      USER_SETTINGS_COLLECTION,
      user.uid,
      USER_SETTINGS_SUBCOLLECTION,
      USER_SETTINGS_DOC_ID
    );

    try {
      const snap = await getDoc(refDoc);
      const remoteData = snap.exists()
        ? (snap.data() as Partial<PersistedUserState>)
        : null;
      const result = mergeUserStates(local, remoteData, deviceId);
      if (result.applyRemoteCamera || result.applyRemoteConfig || result.applyRemotePoiOverrides) {
        this.saveLocalState(result.merged);
      }
      if (result.shouldPushCloud || !snap.exists()) {
        await this.flushCloudPush(user);
      } else {
        cloudSyncDirty = false;
      }
      return result;
    } catch (err) {
      console.warn('[UserStateSync] Cloud pull/merge failed:', err);
      return null;
    }
  }

  static subscribeRemoteState(
    user: NavUser,
    onRemoteUpdate: (result: MergeUserStateResult) => void
  ): () => void {
    const services = getFirebaseServices();
    if (!services) return () => {};

    const deviceId = getOrCreateDeviceId();
    const refDoc = doc(
      services.firestore,
      USER_SETTINGS_COLLECTION,
      user.uid,
      USER_SETTINGS_SUBCOLLECTION,
      USER_SETTINGS_DOC_ID
    );

    return onSnapshot(
      refDoc,
      (snap) => {
        if (!snap.exists() || snap.metadata.hasPendingWrites) return;
        const remoteData = snap.data() as Partial<PersistedUserState>;
        const local = this.loadLocalState();
        const result = mergeUserStates(local, remoteData, deviceId);
        if (result.applyRemoteCamera || result.applyRemoteConfig || result.applyRemotePoiOverrides) {
          this.saveLocalState(result.merged);
          onRemoteUpdate(result);
        }
      },
      (err) => {
        console.warn('[UserStateSync] Snapshot subscription warning:', err);
      }
    );
  }
}
