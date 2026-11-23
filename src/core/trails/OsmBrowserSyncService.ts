import { type NavUser } from '../firebase/AuthService';
import { communityRoadsCloudService } from '../firebase/CommunityRoadsCloudService';
import { trailAnnotationsCloudService } from '../firebase/TrailAnnotationsCloudService';
import { isRemovedOsmRoad, type CommunityRoadRecord } from './CommunityRoadTypes';
import type { TrailAnnotationRecord } from './TrailAnnotationTypes';
import {
  buildOsmChangeXml,
  osmFetch,
  prepareRoadOsmContext,
  pushRoadToOsmApi,
  type OsmSyncRoadInput,
} from './osmSyncCore.js';

const PKCE_MAP_STORAGE_KEY = 'navapp_osm_pkce_map';
const PKCE_TTL_MS = 30 * 60 * 1000;
const SESSION_STORAGE_KEY = 'navapp_osm_session';
const CLIENT_ID_PROD_KEY = 'navapp_osm_client_id_prod';
const CLIENT_ID_SANDBOX_KEY = 'navapp_osm_client_id_sandbox';
const AUTH_CHANNEL_NAME = 'navapp_osm_auth';

export const OSM_PROD_WEB_BASE = 'https://www.openstreetmap.org';
export const OSM_PROD_API_BASE = 'https://api.openstreetmap.org';
export const OSM_SANDBOX_BASE = 'https://master.apis.dev.openstreetmap.org';

export interface OsmOAuthSession {
  accessToken: string;
  osmUser: string;
  sandbox: boolean;
  clientId: string;
  authenticatedAt: string;
}

interface PendingPkceState {
  codeVerifier: string;
  state: string;
  sandbox: boolean;
  clientId: string;
  returnPath: string;
  isPopup?: boolean;
  createdAt: number;
}

export interface OsmSyncRoadItem {
  road: CommunityRoadRecord;
  synced: boolean;
  trailAnnotation: { color?: string; number?: string } | null;
}

export interface OsmRoadSyncResult {
  roadId: string;
  ok: boolean;
  changesetId?: number;
  osmWayId?: number;
  osmVersion?: number;
  message: string;
}

function getStorage(kind: 'local' | 'session'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getOsmWebBase(sandbox: boolean): string {
  return sandbox ? OSM_SANDBOX_BASE : OSM_PROD_WEB_BASE;
}

export function getOsmApiBase(sandbox: boolean): string {
  return sandbox ? OSM_SANDBOX_BASE : OSM_PROD_API_BASE;
}

export function getOsmRedirectUri(): string {
  if (typeof window === 'undefined') return '/osm-callback';
  return `${window.location.origin}/osm-callback`;
}

export function getEnvOsmClientId(sandbox: boolean): string {
  const env = (typeof import.meta !== 'undefined' ? (import.meta as any).env : {}) || {};
  const raw = sandbox ? env.VITE_OSM_SANDBOX_CLIENT_ID : env.VITE_OSM_CLIENT_ID;
  return typeof raw === 'string' ? raw.trim() : '';
}

export function getConfiguredOsmClientId(sandbox: boolean): string {
  const storage = getStorage('local');
  const key = sandbox ? CLIENT_ID_SANDBOX_KEY : CLIENT_ID_PROD_KEY;
  const saved = storage?.getItem(key)?.trim() || '';
  return saved || getEnvOsmClientId(sandbox);
}

export function saveOsmClientId(clientId: string, sandbox: boolean): void {
  const trimmed = clientId.trim();
  const storage = getStorage('local');
  if (!storage || !trimmed) return;
  storage.setItem(sandbox ? CLIENT_ID_SANDBOX_KEY : CLIENT_ID_PROD_KEY, trimmed);
}

export function clearSavedOsmClientId(sandbox: boolean): void {
  const storage = getStorage('local');
  if (!storage) return;
  storage.removeItem(sandbox ? CLIENT_ID_SANDBOX_KEY : CLIENT_ID_PROD_KEY);
}

function readStorageItem(key: string): string | null {
  const local = getStorage('local');
  const session = getStorage('session');
  return local?.getItem(key) ?? session?.getItem(key) ?? null;
}

function writeStorageItem(key: string, value: string): void {
  const local = getStorage('local');
  const session = getStorage('session');
  try {
    local?.setItem(key, value);
  } catch {
    // Ignore quota/security errors and fall back to sessionStorage
  }
  try {
    session?.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
}

function removeStorageItem(key: string): void {
  try {
    getStorage('local')?.removeItem(key);
  } catch {
    // Ignore
  }
  try {
    getStorage('session')?.removeItem(key);
  } catch {
    // Ignore
  }
}

function readPendingPkceMap(): Record<string, PendingPkceState> {
  const raw = readStorageItem(PKCE_MAP_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, PendingPkceState>;
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const fresh: Record<string, PendingPkceState> = {};
    for (const [k, entry] of Object.entries(parsed)) {
      if (
        entry &&
        typeof entry.codeVerifier === 'string' &&
        typeof entry.state === 'string' &&
        (!entry.createdAt || now - entry.createdAt <= PKCE_TTL_MS)
      ) {
        fresh[k] = entry;
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

function savePendingPkceEntry(entry: PendingPkceState): void {
  const map = readPendingPkceMap();
  const entries = Object.values(map)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(-9);
  const next: Record<string, PendingPkceState> = {};
  for (const item of entries) {
    next[item.state] = item;
  }
  next[entry.state] = entry;
  writeStorageItem(PKCE_MAP_STORAGE_KEY, JSON.stringify(next));
}

function consumePendingPkceEntry(state: string): PendingPkceState | null {
  const map = readPendingPkceMap();
  const found = map[state] || null;
  if (found) {
    delete map[state];
    writeStorageItem(PKCE_MAP_STORAGE_KEY, JSON.stringify(map));
  }
  return found;
}

export function getStoredOsmSession(): OsmOAuthSession | null {
  try {
    const raw = readStorageItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OsmOAuthSession>;
    if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.accessToken) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      osmUser: typeof parsed.osmUser === 'string' ? parsed.osmUser : '',
      sandbox: Boolean(parsed.sandbox),
      clientId: typeof parsed.clientId === 'string' ? parsed.clientId : '',
      authenticatedAt: typeof parsed.authenticatedAt === 'string' ? parsed.authenticatedAt : '',
    };
  } catch {
    return null;
  }
}

export function clearOsmSession(): void {
  removeStorageItem(SESSION_STORAGE_KEY);
}

function notifyAuthChannel(payload: { type: 'osm-auth-complete'; session: OsmOAuthSession } | { type: 'osm-auth-error'; error: string }): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(AUTH_CHANNEL_NAME);
    ch.postMessage(payload);
    ch.close();
  } catch {
    // Ignore BroadcastChannel errors
  }
}

export function subscribeOsmAuthUpdates(
  onSession: (session: OsmOAuthSession) => void,
  onError?: (error: string) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (ev: StorageEvent) => {
    if (ev.key === SESSION_STORAGE_KEY) {
      const next = getStoredOsmSession();
      if (next) onSession(next);
    }
  };
  window.addEventListener?.('storage', onStorage);

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
      channel.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as
          | { type?: string; session?: OsmOAuthSession; error?: string }
          | undefined;
        if (msg?.type === 'osm-auth-complete' && msg.session?.accessToken) {
          onSession(msg.session);
        } else if (msg?.type === 'osm-auth-error' && msg.error && onError) {
          onError(msg.error);
        }
      };
    } catch {
      channel = null;
    }
  }

  return () => {
    window.removeEventListener?.('storage', onStorage);
    channel?.close();
  };
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const codeVerifier = base64UrlEncode(randomBytes);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier)
  );
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

export async function buildOsmAuthorizeUrl(params: {
  clientId: string;
  sandbox: boolean;
  returnPath?: string;
  isPopup?: boolean;
}): Promise<string> {
  const clientId = params.clientId.trim();
  if (!clientId) {
    throw new Error('חסר OSM Client ID.');
  }
  const { codeVerifier, codeChallenge } = await createPkcePair();
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = base64UrlEncode(stateBytes);
  const redirectUri = getOsmRedirectUri();
  const pending: PendingPkceState = {
    codeVerifier,
    state,
    sandbox: params.sandbox,
    clientId,
    returnPath: params.returnPath || '/osm-sync',
    isPopup: Boolean(params.isPopup),
    createdAt: Date.now(),
  };
  savePendingPkceEntry(pending);

  const authUrl = new URL(`${getOsmWebBase(params.sandbox)}/oauth2/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'write_api');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  return authUrl.toString();
}

export async function startOsmOAuthLogin(params: {
  clientId: string;
  sandbox: boolean;
  returnPath?: string;
  popupWindow?: Window | null;
}): Promise<{ openedInPopup: boolean }> {
  const popup = params.popupWindow || null;
  try {
    const url = await buildOsmAuthorizeUrl({
      ...params,
      isPopup: Boolean(popup),
    });
    if (popup && !popup.closed) {
      popup.location.replace(url);
      return { openedInPopup: true };
    }
    window.location.assign(url);
    return { openedInPopup: false };
  } catch (err) {
    if (popup && !popup.closed) {
      popup.close();
    }
    throw err;
  }
}

const callbackExchangeCache = new Map<
  string,
  Promise<{ session: OsmOAuthSession; returnPath: string; isPopup: boolean }>
>();

export async function completeOsmOAuthCallback(
  searchParams: URLSearchParams
): Promise<{ session: OsmOAuthSession; returnPath: string; isPopup: boolean }> {
  const oauthError = searchParams.get('error');
  const oauthErrorDesc = searchParams.get('error_description');
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const cacheKey = `${code || ''}:${state || ''}:${oauthError || ''}`;
  const existing = callbackExchangeCache.get(cacheKey);
  if (existing) return existing;

  const task = (async () => {
    try {
      if (oauthError) {
        throw new Error(
          `התחברות OSM בוטלה (${oauthError}${oauthErrorDesc ? `: ${oauthErrorDesc}` : ''})`
        );
      }

      if (!code) {
        throw new Error(
          `כתובת החזרה מ-OSM אינה מכילה פרמטר code (${getOsmRedirectUri()}). נסה להתחבר שוב.`
        );
      }

      if (!state) {
        throw new Error(
          `כתובת החזרה מ-OSM אינה מכילה פרמטר state (${getOsmRedirectUri()}). נסה להתחבר שוב.`
        );
      }

      const pending = consumePendingPkceEntry(state);
      if (!pending) {
        const originHint = typeof window !== 'undefined' ? window.location.origin : '';
        throw new Error(
          `לא נמצאו נתוני PKCE שמורים עבור בקשת ההתחברות (אוריג׳ין נוכחי: ${originHint}). ייתכן שהאחסון המקומי נוקה או שהדומיין/פרוטוקול השתנה. נסה להתחבר שוב.`
        );
      }

      const osmWebBase = getOsmWebBase(pending.sandbox);
      const tokenRes = await fetch(`${osmWebBase}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: getOsmRedirectUri(),
          client_id: pending.clientId,
          code_verifier: pending.codeVerifier,
        }),
      });
      const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
        access_token?: string;
        error_description?: string;
        error?: string;
      };
      if (!tokenRes.ok || !tokenJson.access_token) {
        const detail = tokenJson.error_description || tokenJson.error || String(tokenRes.status);
        if (
          tokenJson.error === 'invalid_client' ||
          /client authentication failed|no client authentication/i.test(detail)
        ) {
          throw new Error(
            `החלפת טוקן OSM נכשלה (${detail}): אפליקציית ה-OAuth2 הנוכחית מסומנת ב-OSM כ-Confidential (ברירת המחדל ב-OSM, ולא ניתן לבטל זאת באפליקציה קיימת). יש ליצור App חדש ב-OSM, להסיר את הסימון מ-"Confidential application?", לסמן הרשאת write_api ולהגדיר Redirect URI: ${getOsmRedirectUri()}, ואז להדביק כאן את ה-Client ID החדש.`
          );
        }
        throw new Error(`החלפת טוקן OSM נכשלה: ${detail}`);
      }

      let osmUser = '';
      try {
        const userXml = await osmFetch(
          `${getOsmApiBase(pending.sandbox)}/api/0.6/user/details`,
          {},
          tokenJson.access_token
        );
        const match = /display_name="([^"]+)"/.exec(userXml);
        osmUser = match ? match[1] : '';
      } catch {
        osmUser = '';
      }

      const session: OsmOAuthSession = {
        accessToken: tokenJson.access_token,
        osmUser,
        sandbox: pending.sandbox,
        clientId: pending.clientId,
        authenticatedAt: new Date().toISOString(),
      };
      writeStorageItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      notifyAuthChannel({ type: 'osm-auth-complete', session });

      return {
        session,
        returnPath: pending.returnPath || '/osm-sync',
        isPopup: Boolean(pending.isPopup),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyAuthChannel({ type: 'osm-auth-error', error: msg });
      throw err;
    }
  })();

  callbackExchangeCache.set(cacheKey, task);
  return task;
}

export function buildOsmSyncRoadItems(
  roads: CommunityRoadRecord[],
  annotations: TrailAnnotationRecord[]
): OsmSyncRoadItem[] {
  const trailByWayId = new Map<string, { color?: string; number?: string }>();
  for (const annotation of annotations) {
    if (annotation.status !== 'active' || !Array.isArray(annotation.wayIds)) continue;
    for (const wayId of annotation.wayIds) {
      trailByWayId.set(wayId, {
        color: annotation.color,
        number: annotation.number,
      });
    }
  }

  return roads
    // Removed-road tombstones are app-only: a way is never deleted from OpenStreetMap by this sync
    .filter((road) => road.status === 'active' && !isRemovedOsmRoad(road))
    .map((road) => {
      const synced = Boolean(
        road.osmSync && Number(road.osmSync.syncedRevision) >= Number(road.revision)
      );
      const wayKey =
        road.kind === 'osm-override' ? road.sourceOsmWayId || '' : `community:road:${road.id}`;
      const directTrail = road.trailColor
        ? { color: road.trailColor, number: road.trailNumber || '' }
        : null;
      return {
        road,
        synced,
        trailAnnotation: directTrail || (wayKey ? trailByWayId.get(wayKey) || null : null),
      };
    });
}

function toOsmSyncRoadInput(item: OsmSyncRoadItem): OsmSyncRoadInput {
  const { road, trailAnnotation } = item;
  return {
    id: road.id,
    kind: road.kind,
    sourceOsmWayId: road.sourceOsmWayId,
    coordinates: road.coordinates,
    highwayClass: road.highwayClass,
    tracktype: road.tracktype,
    surface: road.surface,
    name: road.name,
    description: road.description,
    oneway: road.oneway,
    allow4x4: road.allow4x4,
    allowFoot: road.allowFoot,
    allowBicycle: road.allowBicycle,
    anchors: road.anchors,
    trailAnnotation,
  };
}

export async function loadOsmSyncItems(): Promise<{
  items: OsmSyncRoadItem[];
  warning?: string;
}> {
  const [roadsResult, trailsResult] = await Promise.all([
    communityRoadsCloudService.loadCommunityRoads(),
    trailAnnotationsCloudService.loadPublishedAnnotations(),
  ]);
  const items = buildOsmSyncRoadItems(roadsResult.roads, trailsResult.annotations);
  const warnings = [roadsResult.warning, trailsResult.warning].filter(Boolean);
  return {
    items,
    warning: warnings.length > 0 ? warnings.join(' · ') : undefined,
  };
}

export async function previewRoadOsmXml(
  item: OsmSyncRoadItem,
  sandbox: boolean
): Promise<string> {
  const input = toOsmSyncRoadInput(item);
  const existingTargetWays = await prepareRoadOsmContext(input, getOsmApiBase(sandbox));
  return buildOsmChangeXml({
    changesetId: 0,
    road: input,
    trailAnnotation: item.trailAnnotation,
    existingTargetWays,
  });
}

export async function syncRoadToOsmFromBrowser(
  item: OsmSyncRoadItem,
  options: {
    osmSession: OsmOAuthSession;
    user: NavUser;
    sandbox: boolean;
  }
): Promise<OsmRoadSyncResult> {
  const { osmSession, user, sandbox } = options;
  if (item.road.cloudSyncStatus === 'pending' || item.road.cloudSyncStatus === 'error') {
    await communityRoadsCloudService.syncPendingRoads(user);
  }

  const actorName = user.displayName || user.email || user.uid;
  const uploaded = await pushRoadToOsmApi({
    road: toOsmSyncRoadInput(item),
    osmApiBase: getOsmApiBase(sandbox),
    osmToken: osmSession.accessToken,
    actorUid: user.uid,
    actorName,
  });

  try {
    await communityRoadsCloudService.markRoadOsmSynced({
      roadId: item.road.id,
      user,
      changesetId: uploaded.changesetId,
      osmWayId: uploaded.osmWayId,
      osmVersion: uploaded.osmVersion,
      osmUsername: osmSession.osmUser || undefined,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      roadId: item.road.id,
      ok: false,
      changesetId: uploaded.changesetId,
      osmWayId: uploaded.osmWayId,
      osmVersion: uploaded.osmVersion,
      message: `הועלה ל-OSM (changeset #${uploaded.changesetId}), אך עדכון הסטטוס ב-Firestore נכשל: ${reason}`,
    };
  }

  return {
    roadId: item.road.id,
    ok: true,
    changesetId: uploaded.changesetId,
    osmWayId: uploaded.osmWayId,
    osmVersion: uploaded.osmVersion,
    message: `סונכרן בהצלחה: changeset #${uploaded.changesetId} (way #${uploaded.osmWayId} v${uploaded.osmVersion})`,
  };
}
