import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Code2,
  ExternalLink,
  Link2,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  Settings2,
  UploadCloud,
  X,
} from 'lucide-react';
import type { NavUser } from '../../core/firebase/AuthService';
import {
  clearOsmSession,
  getConfiguredOsmClientId,
  getOsmRedirectUri,
  getOsmWebBase,
  getStoredOsmSession,
  loadOsmSyncItems,
  previewRoadOsmXml,
  saveOsmClientId,
  startOsmOAuthLogin,
  subscribeOsmAuthUpdates,
  syncRoadToOsmFromBrowser,
  type OsmOAuthSession,
  type OsmRoadSyncResult,
  type OsmSyncRoadItem,
} from '../../core/trails/OsmBrowserSyncService';
import { getHighwayClassLabelHe } from '../../core/trails/CommunityRoadTypes';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface OsmSyncPanelProps {
  theme: MapTheme;
  currentUser: NavUser | null;
  firebaseAvailable: boolean;
  isAuthBusy: boolean;
  isOnline: boolean;
  fullPage?: boolean;
  initialCallbackError?: string | null;
  onSignInGoogle: () => void;
  onClose: () => void;
  onRoadsUpdated?: () => void;
}

export const OsmSyncPanel: React.FC<OsmSyncPanelProps> = ({
  theme,
  currentUser,
  firebaseAvailable,
  isAuthBusy,
  isOnline,
  fullPage = false,
  initialCallbackError = null,
  onSignInGoogle,
  onClose,
  onRoadsUpdated,
}) => {
  const t = getSurfaceTheme(theme);
  const initialSession = useMemo(() => getStoredOsmSession(), []);
  const [sandbox, setSandbox] = useState<boolean>(initialSession?.sandbox ?? false);
  const [osmSession, setOsmSession] = useState<OsmOAuthSession | null>(initialSession);
  const [clientId, setClientId] = useState<string>(() =>
    getConfiguredOsmClientId(initialSession?.sandbox ?? false)
  );
  const [clientIdInput, setClientIdInput] = useState<string>(() =>
    getConfiguredOsmClientId(initialSession?.sandbox ?? false)
  );
  const [editingClientId, setEditingClientId] = useState<boolean>(false);

  const [items, setItems] = useState<OsmSyncRoadItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showSynced, setShowSynced] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string>(initialCallbackError || '');
  const [previews, setPreviews] = useState<Record<string, { loading?: boolean; xml?: string; error?: string }>>({});
  const [results, setResults] = useState<Record<string, OsmRoadSyncResult>>({});
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isOAuthRedirecting, setIsOAuthRedirecting] = useState<boolean>(false);

  useEffect(() => {
    if (initialCallbackError && /Confidential|Client ID/i.test(initialCallbackError)) {
      setEditingClientId(true);
    }
  }, [initialCallbackError]);

  const redirectUri = useMemo(() => getOsmRedirectUri(), []);

  const refreshRoads = useCallback(async () => {
    setIsLoading(true);
    setLoadError((prev) => (prev === initialCallbackError ? prev : ''));
    try {
      const { items: loaded, warning } = await loadOsmSyncItems();
      setItems(loaded);
      setSelectedIds(new Set(loaded.filter((item) => !item.synced).map((item) => item.road.id)));
      if (warning) {
        setLoadError(warning);
      }
      onRoadsUpdated?.();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [initialCallbackError, onRoadsUpdated]);

  useEffect(() => {
    void refreshRoads();
  }, [refreshRoads]);

  useEffect(() => {
    return subscribeOsmAuthUpdates(
      (session) => {
        setOsmSession(session);
        setSandbox(session.sandbox);
        setIsOAuthRedirecting(false);
        setLoadError('');
      },
      (errorMsg) => {
        setIsOAuthRedirecting(false);
        setLoadError(errorMsg);
      }
    );
  }, []);

  const handleSandboxToggle = (nextSandbox: boolean) => {
    setSandbox(nextSandbox);
    const nextClientId = getConfiguredOsmClientId(nextSandbox);
    setClientId(nextClientId);
    setClientIdInput(nextClientId);
    setEditingClientId(false);
    setPreviews({});
    if (osmSession && osmSession.sandbox !== nextSandbox) {
      clearOsmSession();
      setOsmSession(null);
    }
  };

  const handleSaveClientId = () => {
    const trimmed = clientIdInput.trim();
    if (!trimmed) return;
    saveOsmClientId(trimmed, sandbox);
    setClientId(trimmed);
    setEditingClientId(false);
  };

  const handleOsmLogin = async () => {
    const activeClientId = clientId.trim();
    if (!activeClientId) {
      setEditingClientId(true);
      return;
    }
    setIsOAuthRedirecting(true);
    setLoadError('');
    try {
      await startOsmOAuthLogin({
        clientId: activeClientId,
        sandbox,
        returnPath: fullPage ? '/osm-sync' : '/?osmSync=1',
      });
    } catch (err) {
      setIsOAuthRedirecting(false);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOsmLogout = () => {
    clearOsmSession();
    setOsmSession(null);
  };

  const handlePreviewXml = async (item: OsmSyncRoadItem) => {
    const id = item.road.id;
    if (previews[id]?.xml && !previews[id]?.error) {
      setPreviews((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setPreviews((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      const xml = await previewRoadOsmXml(item, sandbox);
      setPreviews((prev) => ({ ...prev, [id]: { xml } }));
    } catch (err) {
      setPreviews((prev) => ({
        ...prev,
        [id]: { error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const handleSyncSelected = async () => {
    if (!currentUser || !osmSession || selectedIds.size === 0 || isSyncing) return;
    setIsSyncing(true);
    const idsToSync = Array.from(selectedIds);
    try {
      for (const id of idsToSync) {
        const item = items.find((entry) => entry.road.id === id);
        if (!item) continue;
        try {
          const result = await syncRoadToOsmFromBrowser(item, {
            osmSession,
            user: currentUser,
            sandbox,
          });
          setResults((prev) => ({ ...prev, [id]: result }));
        } catch (err) {
          setResults((prev) => ({
            ...prev,
            [id]: {
              roadId: id,
              ok: false,
              message: err instanceof Error ? err.message : String(err),
            },
          }));
        }
      }
      await refreshRoads();
    } finally {
      setIsSyncing(false);
    }
  };

  const visibleItems = useMemo(
    () => (showSynced ? items : items.filter((item) => !item.synced)),
    [items, showSynced]
  );
  const pendingCount = useMemo(() => items.filter((item) => !item.synced).length, [items]);
  const syncedCount = items.length - pendingCount;
  const showClientIdForm = !osmSession && (!clientId || editingClientId);

  const shellClass = fullPage
    ? `fixed inset-0 z-[90] w-full overflow-y-auto select-text p-4 sm:p-6 ${theme === 'topo-dark' ? 'bg-slate-950 text-slate-100' : 'bg-slate-100 text-slate-900'}`
    : 'fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-3 sm:p-6 backdrop-blur-xs select-text';

  const cardClass = fullPage
    ? `mx-auto flex w-full max-w-4xl flex-col gap-3 rounded-2xl border p-4 sm:p-6 shadow-xl ${t.panel}`
    : `flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border shadow-2xl ${t.panel}`;

  return (
    <div dir="rtl" className={shellClass} role="dialog" aria-label="סנכרון דרכים ל-OpenStreetMap">
      <div className={cardClass}>
        {/* Header */}
        <header className={`flex items-start justify-between gap-3 border-b pb-3 ${fullPage ? '' : 'px-4 pt-4'} ${t.divider}`}>
          <div>
            <h1 className="text-base sm:text-lg font-bold flex items-center gap-2">
              <UploadCloud className="h-5 w-5 text-emerald-500 shrink-0" />
              <span>NavApp — סנכרון דרכים ל-OpenStreetMap</span>
            </h1>
            <p className={`mt-0.5 text-xs ${t.muted}`}>
              התחבר עם משתמש ה-OpenStreetMap שלך, בחר דרכים לסנכרון, ובדוק את ה-OsmChange XML לפני השליחה.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shrink-0 ${t.pillBtn}`}
          >
            {fullPage ? (
              <>
                <ArrowRight className="h-3.5 w-3.5" />
                <span>חזרה למפה</span>
              </>
            ) : (
              <>
                <X className="h-4 w-4" />
                <span>סגור</span>
              </>
            )}
          </button>
        </header>

        {/* Scrollable Content */}
        <div className={`flex-1 space-y-3 overflow-y-auto ${fullPage ? '' : 'p-4'}`}>
          {/* 1. Firebase / Google Auth Status */}
          <div className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-xs ${t.subCard}`}>
            <div className="flex items-center gap-2">
              {currentUser ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <span>
                    מחובר ל-NavApp (Google):{' '}
                    <strong>{currentUser.displayName || currentUser.email || currentUser.uid}</strong>
                  </span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                  <span>יש להתחבר ל-Google כדי לשמור את אישור הסנכרון ב-Firestore.</span>
                </>
              )}
            </div>
            {!currentUser && (
              <button
                type="button"
                onClick={onSignInGoogle}
                disabled={!firebaseAvailable || isAuthBusy || !isOnline}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-45"
              >
                <LogIn className="h-3.5 w-3.5" />
                <span>התחבר עם Google</span>
              </button>
            )}
          </div>

          {/* 2. OpenStreetMap OAuth 2.0 PKCE Status */}
          <div className={`space-y-2.5 rounded-xl border px-3 py-2.5 text-xs ${t.subCard}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {osmSession ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-sky-500 shrink-0" />
                    <span>
                      מחובר ל-OSM ({osmSession.sandbox ? 'Sandbox' : 'Production'})
                      {osmSession.osmUser ? (
                        <>
                          : <strong dir="ltr">{osmSession.osmUser}</strong>
                        </>
                      ) : null}
                    </span>
                  </>
                ) : (
                  <>
                    <Link2 className="h-4 w-4 text-amber-500 shrink-0" />
                    <span>לא מחובר ל-OpenStreetMap</span>
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={sandbox}
                    onChange={(e) => handleSandboxToggle(e.target.checked)}
                    disabled={isSyncing}
                  />
                  <span>מצב Sandbox (master.apis.dev)</span>
                </label>

                {!osmSession && clientId && !editingClientId && (
                  <>
                    <button
                      type="button"
                      onClick={() => setEditingClientId(true)}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs ${t.pillBtn}`}
                      title="הגדרות OAuth Client ID"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      <span>Client ID</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleOsmLogin()}
                      disabled={isOAuthRedirecting || !isOnline}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-45"
                    >
                      {isOAuthRedirecting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <LogIn className="h-3.5 w-3.5" />
                      )}
                      <span>התחבר עם משתמש OSM</span>
                    </button>
                  </>
                )}

                {osmSession && (
                  <button
                    type="button"
                    onClick={handleOsmLogout}
                    disabled={isSyncing}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${t.pillBtn}`}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span>התנתק מ-OSM</span>
                  </button>
                )}
              </div>
            </div>

            {showClientIdForm && (
              <div className={`space-y-2 border-t pt-2.5 ${t.divider}`}>
                <div className={`text-[11px] leading-relaxed ${t.muted}`}>
                  הגדרה חד-פעמית ({sandbox ? 'Sandbox' : 'Production'}) — צור OAuth2 App חדש ב-OSM{' '}
                  <strong>והסר את הסימון מ-"Confidential application?" (מסומן כברירת מחדל ולא ניתן לשינוי בדיעבד)</strong>, עם הרשאת{' '}
                  <code dir="ltr">write_api</code> ו-Redirect URI:
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <code
                      dir="ltr"
                      className={`rounded border px-2 py-0.5 text-[11px] select-all ${t.fieldBox}`}
                    >
                      {redirectUri}
                    </code>
                    <a
                      href={`${getOsmWebBase(sandbox)}/oauth2/applications/new`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sky-500 underline font-semibold"
                    >
                      <span>צור App ב-OSM</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={clientIdInput}
                    onChange={(e) => setClientIdInput(e.target.value)}
                    placeholder="הדבק Client ID כאן..."
                    dir="ltr"
                    className={`min-w-[240px] flex-1 rounded-lg border px-2.5 py-1.5 text-xs ${t.fieldBox}`}
                  />
                  <button
                    type="button"
                    onClick={handleSaveClientId}
                    disabled={!clientIdInput.trim()}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-45"
                  >
                    שמור Client ID
                  </button>
                  {clientId && (
                    <button
                      type="button"
                      onClick={() => {
                        setClientIdInput(clientId);
                        setEditingClientId(false);
                      }}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs ${t.pillBtn}`}
                    >
                      ביטול
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 3. Toolbar */}
          <div className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-xs ${t.subCard}`}>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedIds(new Set(visibleItems.map((item) => item.road.id)))}
                disabled={visibleItems.length === 0 || isSyncing}
                className={`rounded-lg border px-2.5 py-1.5 font-semibold disabled:opacity-45 ${t.pillBtn}`}
              >
                בחר הכל
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                disabled={selectedIds.size === 0 || isSyncing}
                className={`rounded-lg border px-2.5 py-1.5 font-semibold disabled:opacity-45 ${t.pillBtn}`}
              >
                בטל בחירה
              </button>
              <button
                type="button"
                onClick={() => void refreshRoads()}
                disabled={isLoading || isSyncing}
                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 font-semibold disabled:opacity-45 ${t.pillBtn}`}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                <span>רענן</span>
              </button>
              <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showSynced}
                  onChange={(e) => setShowSynced(e.target.checked)}
                />
                <span>הצג גם דרכים שסונכרנו ({syncedCount})</span>
              </label>
            </div>

            <div className="flex items-center gap-2">
              <span className={`text-[11px] ${t.muted}`}>
                ממתינות: {pendingCount}
              </span>
              <button
                type="button"
                onClick={() => void handleSyncSelected()}
                disabled={
                  !isOnline ||
                  !currentUser ||
                  !osmSession ||
                  selectedIds.size === 0 ||
                  isSyncing
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-45"
              >
                {isSyncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="h-3.5 w-3.5" />
                )}
                <span>סנכרן נבחרים ל-OSM ({selectedIds.size})</span>
              </button>
            </div>
          </div>

          {!isOnline && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
              אופליין: נדרש חיבור לאינטרנט כדי למשוך נתוני OSM ולבצע סנכרון.
            </div>
          )}

          {typeof window !== 'undefined' && !window.isSecureContext && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
              לתשומת לבך: חיבור OAuth 2.0 PKCE ל-OpenStreetMap דורש חיבור מאובטח (<code dir="ltr">https://</code> או <code dir="ltr">localhost</code>).
            </div>
          )}

          {loadError && (
            <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-500">
              {loadError}
            </div>
          )}

          {/* 4. Roads List */}
          {isLoading ? (
            <div className={`flex items-center justify-center gap-2 rounded-xl border p-6 text-xs ${t.subCard}`}>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>טוען דרכים קהילתיות מ-Firestore...</span>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className={`rounded-xl border p-6 text-center text-xs ${t.subCard} ${t.muted}`}>
              אין דרכים ממתינות לסנכרון ל-OSM.
            </div>
          ) : (
            <div className="space-y-2.5">
              {visibleItems.map((item) => {
                const { road, synced, trailAnnotation } = item;
                const checked = selectedIds.has(road.id);
                const previewState = previews[road.id];
                const result = results[road.id];
                return (
                  <div
                    key={road.id}
                    className={`rounded-xl border p-3 transition-colors ${t.subCard}`}
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isSyncing}
                        onChange={(e) => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(road.id);
                            else next.delete(road.id);
                            return next;
                          });
                        }}
                        className="mt-1 shrink-0"
                        aria-label={`בחר דרך ${road.name || road.id}`}
                      />

                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              road.kind === 'osm-override'
                                ? 'bg-amber-500/20 text-amber-500'
                                : 'bg-emerald-500/20 text-emerald-500'
                            }`}
                          >
                            {road.kind === 'osm-override'
                              ? `עריכת OSM ${road.sourceOsmWayId?.replace('osm:way:', '#') || ''}`
                              : 'דרך חדשה'}
                          </span>

                          {synced ? (
                            <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-bold text-sky-400">
                              סונכרן #{road.osmSync?.changesetId}
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-500/20 px-2 py-0.5 text-[10px] font-semibold">
                              ממתין ל-OSM
                            </span>
                          )}

                          <strong className="text-sm" dir="auto">
                            {road.name || '(ללא שם)'}
                          </strong>

                          <span className={t.muted}>
                            {getHighwayClassLabelHe(road.highwayClass)} · {road.coordinates.length} נק׳
                          </span>

                          {trailAnnotation?.color && (
                            <span className="inline-flex items-center gap-1 text-[11px]">
                              <span
                                className="inline-block h-2.5 w-2.5 rounded-full border border-white/80"
                                style={{ backgroundColor: trailAnnotation.color }}
                              />
                              <span>שביל {trailAnnotation.number || ''}</span>
                            </span>
                          )}
                        </div>

                        <div className={`text-[11px] ${t.muted}`}>
                          משתמש NavApp: <span dir="ltr">{road.updatedByUid || road.createdByUid}</span> · גרסה{' '}
                          {road.revision}
                          {road.osmSync?.osmWayId ? (
                            <>
                              {' '}
                              · OSM way{' '}
                              <a
                                href={`${getOsmWebBase(sandbox)}/way/${road.osmSync.osmWayId}`}
                                target="_blank"
                                rel="noreferrer"
                                className="underline text-sky-500"
                              >
                                #{road.osmSync.osmWayId}
                              </a>
                            </>
                          ) : null}
                        </div>

                        {result && (
                          <div
                            className={`text-xs font-semibold ${
                              result.ok ? 'text-emerald-500' : 'text-rose-500'
                            }`}
                          >
                            {result.message}
                          </div>
                        )}

                        <div className="pt-0.5">
                          <button
                            type="button"
                            onClick={() => void handlePreviewXml(item)}
                            disabled={previewState?.loading || !isOnline}
                            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-45 ${t.pillBtn}`}
                          >
                            {previewState?.loading ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Code2 className="h-3 w-3" />
                            )}
                            <span>{previewState?.xml ? 'הסתר XML' : 'תצוגה מקדימה XML'}</span>
                          </button>
                        </div>

                        {previewState?.error && (
                          <p className="text-[11px] text-rose-500">{previewState.error}</p>
                        )}

                        {previewState?.xml && (
                          <pre
                            dir="ltr"
                            className="max-h-64 overflow-auto rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-left text-[11px] text-slate-200"
                          >
                            {previewState.xml}
                          </pre>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
