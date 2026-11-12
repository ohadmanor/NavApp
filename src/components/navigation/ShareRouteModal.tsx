import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Loader2,
  Mail,
  Plus,
  Search,
  Share2,
  Trash2,
  UserPlus,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import type { RouteShareRecipient, SavedRouteRecord } from '../../core/db/NavDatabase';
import type { NavUser } from '../../core/firebase/AuthService';
import {
  UserDirectoryService,
  type AppDirectoryUser,
} from '../../core/firebase/UserDirectoryService';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

interface ShareRouteModalProps {
  route: SavedRouteRecord;
  theme?: MapTheme;
  currentUser: NavUser | null;
  isOnline: boolean;
  firebaseAvailable: boolean;
  isAuthBusy?: boolean;
  onSignInGoogle?: () => void | Promise<void>;
  onUpdateRecipients: (
    route: SavedRouteRecord,
    nextRecipients: RouteShareRecipient[]
  ) => Promise<{ synced: boolean; route: SavedRouteRecord; error?: string }>;
  onClose: () => void;
}

export const ShareRouteModal: React.FC<ShareRouteModalProps> = ({
  route,
  theme = 'topo-dark',
  currentUser,
  isOnline,
  firebaseAvailable,
  isAuthBusy = false,
  onSignInGoogle,
  onUpdateRecipients,
  onClose,
}) => {
  const t = getSurfaceTheme(theme);
  const [recipients, setRecipients] = useState<RouteShareRecipient[]>(route.sharedWith || []);
  const [queryText, setQueryText] = useState('');
  const [suggestions, setSuggestions] = useState<AppDirectoryUser[]>([]);
  const [isSearchingUsers, setIsSearchingUsers] = useState(false);
  const [isSavingShare, setIsSavingShare] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  useEffect(() => {
    setRecipients(route.sharedWith || []);
  }, [route.id, route.sharedWith]);

  useEffect(() => {
    const trimmed = queryText.trim();
    if (!trimmed || !currentUser || !isOnline || !firebaseAvailable) {
      setSuggestions([]);
      setIsSearchingUsers(false);
      return;
    }

    let cancelled = false;
    setIsSearchingUsers(true);
    const timer = window.setTimeout(() => {
      void UserDirectoryService.searchUsers(trimmed, currentUser.uid)
        .then((results) => {
          if (!cancelled) {
            setSuggestions(results);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSuggestions([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearchingUsers(false);
          }
        });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [queryText, currentUser, isOnline, firebaseAvailable]);

  const trimmedQuery = queryText.trim();
  const normalizedTypedEmail = EMAIL_PATTERN.test(trimmedQuery)
    ? trimmedQuery.toLowerCase()
    : null;
  const selfEmailLower = (currentUser?.email || '').trim().toLowerCase();

  const alreadyHasRecipient = (candidate: { uid?: string | null; email?: string | null }) => {
    const emailLower = (candidate.email || '').trim().toLowerCase();
    return recipients.some(
      (r) =>
        (candidate.uid && r.uid && r.uid === candidate.uid) ||
        (emailLower && r.email.trim().toLowerCase() === emailLower)
    );
  };

  const canInviteTypedEmail = useMemo(() => {
    if (!normalizedTypedEmail) return false;
    if (selfEmailLower && normalizedTypedEmail === selfEmailLower) return false;
    if (alreadyHasRecipient({ email: normalizedTypedEmail })) return false;
    const exactMatchInSuggestions = suggestions.some(
      (s) => s.emailLower === normalizedTypedEmail
    );
    return !exactMatchInSuggestions;
  }, [normalizedTypedEmail, selfEmailLower, recipients, suggestions]);

  const applyRecipientsUpdate = async (
    nextList: RouteShareRecipient[],
    successMsg: string
  ) => {
    setIsSavingShare(true);
    setStatusError(null);
    setStatusNote(null);
    try {
      const res = await onUpdateRecipients(route, nextList);
      setRecipients(res.route.sharedWith || nextList);
      if (res.synced) {
        setStatusNote(successMsg);
      } else {
        setStatusError(
          res.error ||
            'השינוי נשמר במכשיר ויסתנכרן לענן ברגע שיתאפשר חיבור.'
        );
      }
    } catch (err: any) {
      setStatusError(err?.message || 'שגיאה בעדכון שיתוף המסלול');
    } finally {
      setIsSavingShare(false);
    }
  };

  const handleAddDirectoryUser = async (userItem: AppDirectoryUser) => {
    if (isSavingShare || alreadyHasRecipient(userItem)) return;
    const nextRecipient: RouteShareRecipient = {
      uid: userItem.uid,
      email: userItem.emailLower || userItem.email.toLowerCase(),
      displayName: userItem.displayName,
      sharedAt: new Date().toISOString(),
    };
    const nextList = [...recipients, nextRecipient];
    setQueryText('');
    setSuggestions([]);
    await applyRecipientsUpdate(
      nextList,
      `המסלול שותף עם ${userItem.displayName || userItem.email}`
    );
  };

  const handleInviteByEmail = async () => {
    if (!canInviteTypedEmail || !normalizedTypedEmail || isSavingShare) return;
    const nextRecipient: RouteShareRecipient = {
      uid: null,
      email: normalizedTypedEmail,
      displayName: null,
      sharedAt: new Date().toISOString(),
    };
    const nextList = [...recipients, nextRecipient];
    setQueryText('');
    setSuggestions([]);
    await applyRecipientsUpdate(
      nextList,
      `נשלחה הזמנת שיתוף אל ${normalizedTypedEmail}`
    );
  };

  const handleRemoveRecipient = async (target: RouteShareRecipient) => {
    if (isSavingShare) return;
    const targetEmail = target.email.trim().toLowerCase();
    const nextList = recipients.filter(
      (r) =>
        !(
          (target.uid && r.uid && r.uid === target.uid) ||
          (targetEmail && r.email.trim().toLowerCase() === targetEmail)
        )
    );
    await applyRecipientsUpdate(
      nextList,
      `הגישה של ${target.displayName || target.email} הוסרה`
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`שיתוף מסלול ${route.name}`}
      onClick={onClose}
    >
      <div
        dir="rtl"
        className={`w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden flex flex-col max-h-[85vh] ${t.panelSolid}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`px-4 py-3 border-b flex items-center justify-between gap-2 ${t.divider}`}>
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center shrink-0">
              <Share2 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold truncate" dir="auto">
                שיתוף מסלול: {route.name}
              </h3>
              <div dir="ltr" className={`text-[11px] font-mono ${t.muted}`}>
                {route.distanceKm} km • +{route.ascentMeters}m
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`p-1.5 rounded-lg border shrink-0 ${t.pillBtn}`}
            aria-label="סגור חלון שיתוף"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          {!firebaseAvailable ? (
            <div className={`p-3 rounded-xl border text-xs ${t.subCard}`}>
              שירותי הענן של Firebase אינם מוגדרים בסביבה זו.
            </div>
          ) : !currentUser ? (
            <div className={`p-4 rounded-xl border text-center space-y-3 ${t.subCard}`}>
              <Users className="w-7 h-7 text-indigo-400 mx-auto" />
              <div className="text-xs font-bold">התחברות נדרשת לשיתוף מסלולים</div>
              <p className={`text-xs ${t.muted}`}>
                התחבר עם חשבון Google שלך כדי לשתף מסלול לפי שם משתמש ב-NavApp או כתובת Gmail.
              </p>
              {onSignInGoogle && (
                <button
                  type="button"
                  disabled={isAuthBusy}
                  onClick={() => void onSignInGoogle()}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold inline-flex items-center gap-1.5"
                >
                  {isAuthBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>התחבר עם Google לשיתוף</span>
                </button>
              )}
            </div>
          ) : (
            <>
              {!isOnline && (
                <div className="px-3 py-2 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs flex items-center gap-2">
                  <WifiOff className="w-4 h-4 shrink-0" />
                  <span>אתה במצב אופליין. הוספת נמען לפי Gmail תסתנכרן בחיבור הבא.</span>
                </div>
              )}

              {/* Recipient Autocomplete Search */}
              <div className="space-y-1.5">
                <label
                  htmlFor="share-route-recipient-input"
                  className={`block text-xs font-bold ${t.muted}`}
                >
                  הוסף משתמש לפי שם או כתובת Gmail
                </label>
                <div
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl border focus-within:border-indigo-500 ${t.fieldBox}`}
                >
                  <Search className={`w-4 h-4 shrink-0 ${t.muted}`} />
                  <input
                    id="share-route-recipient-input"
                    name="shareRecipient"
                    type="text"
                    dir="auto"
                    autoFocus
                    value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && canInviteTypedEmail) {
                        e.preventDefault();
                        void handleInviteByEmail();
                      }
                    }}
                    placeholder="חפש לפי שם משתמש או הזן כתובת Gmail..."
                    className="w-full min-w-0 bg-transparent text-xs focus:outline-none"
                  />
                  {isSearchingUsers && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400 shrink-0" />
                  )}
                  {queryText && !isSearchingUsers && (
                    <button
                      type="button"
                      onClick={() => {
                        setQueryText('');
                        setSuggestions([]);
                      }}
                      className={`p-0.5 rounded hover:bg-black/10 ${t.muted}`}
                      aria-label="נקה חיפוש משתמש"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Autocomplete Suggestions + Direct Gmail Invite */}
                {trimmedQuery && (suggestions.length > 0 || canInviteTypedEmail) && (
                  <div className={`rounded-xl border divide-y overflow-hidden ${t.subCard} ${t.divider}`}>
                    {suggestions.map((u) => {
                      const isAdded = alreadyHasRecipient(u);
                      const initial = (u.displayName || u.email || '?').charAt(0).toUpperCase();
                      return (
                        <div
                          key={u.uid}
                          className={`px-3 py-2 flex items-center justify-between gap-2 ${t.hoverRow}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {u.photoURL ? (
                              <img
                                src={u.photoURL}
                                alt={u.displayName}
                                className="w-7 h-7 rounded-full object-cover shrink-0 border border-white/20"
                              />
                            ) : (
                              <div className="w-7 h-7 rounded-full bg-indigo-500/20 text-indigo-400 text-xs font-bold flex items-center justify-center shrink-0">
                                {initial}
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="text-xs font-bold truncate" dir="auto">
                                {u.displayName}
                              </div>
                              <div className={`text-[11px] font-mono truncate ${t.muted}`} dir="ltr">
                                {u.email}
                              </div>
                            </div>
                          </div>

                          {isAdded ? (
                            <span className="px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-500 text-[11px] font-bold inline-flex items-center gap-1 shrink-0">
                              <Check className="w-3 h-3" />
                              <span>שותף</span>
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={isSavingShare}
                              onClick={() => void handleAddDirectoryUser(u)}
                              className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-[11px] font-bold inline-flex items-center gap-1 shrink-0"
                            >
                              <UserPlus className="w-3 h-3" />
                              <span>שתף</span>
                            </button>
                          )}
                        </div>
                      );
                    })}

                    {canInviteTypedEmail && normalizedTypedEmail && (
                      <div className={`px-3 py-2 flex items-center justify-between gap-2 ${t.hoverRow}`}>
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-sky-500/20 text-sky-400 flex items-center justify-center shrink-0">
                            <Mail className="w-3.5 h-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-bold truncate" dir="ltr">
                              {normalizedTypedEmail}
                            </div>
                            <div className={`text-[11px] ${t.muted}`}>
                              הזמנה לפי אימייל (ממתין לכניסה)
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={isSavingShare}
                          onClick={() => void handleInviteByEmail()}
                          className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-[11px] font-bold inline-flex items-center gap-1 shrink-0"
                        >
                          <Plus className="w-3 h-3" />
                          <span>הזמן</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {trimmedQuery &&
                  !isSearchingUsers &&
                  suggestions.length === 0 &&
                  !canInviteTypedEmail && (
                    <p className={`text-[11px] px-1 ${t.muted}`}>
                      {normalizedTypedEmail === selfEmailLower && selfEmailLower
                        ? 'לא ניתן לשתף מסלול עם עצמך.'
                        : normalizedTypedEmail && alreadyHasRecipient({ email: normalizedTypedEmail })
                          ? 'משתמש זה כבר נמצא ברשימת השיתוף.'
                          : 'לא נמצאו משתמשים תואמים. ניתן להזין כתובת Gmail מלאה.'}
                    </p>
                  )}
              </div>

              {/* Feedback Banners */}
              {isSavingShare && (
                <div className="px-3 py-2 rounded-xl border border-indigo-500/40 bg-indigo-500/10 text-indigo-400 text-xs flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>מעלה ומעדכן הרשאות שיתוף...</span>
                </div>
              )}
              {statusError && (
                <div className="px-3 py-2 rounded-xl border border-red-500/40 bg-red-500/10 text-red-400 text-xs">
                  {statusError}
                </div>
              )}
              {statusNote && !statusError && (
                <div className="px-3 py-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-500 text-xs flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  <span>{statusNote}</span>
                </div>
              )}

              {/* Current Recipients List */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-bold ${t.muted}`}>
                    שותף עם ({recipients.length})
                  </span>
                </div>

                {recipients.length === 0 ? (
                  <div className={`p-3 rounded-xl border border-dashed text-center text-xs ${t.muted} ${t.subCard}`}>
                    מסלול זה פרטי כרגע ואינו משותף עם משתמשים אחרים.
                  </div>
                ) : (
                  <div className={`rounded-xl border divide-y ${t.subCard} ${t.divider}`}>
                    {recipients.map((rec) => {
                      const key = rec.uid || rec.email;
                      const label = rec.displayName || rec.email;
                      const initial = label.charAt(0).toUpperCase();
                      return (
                        <div
                          key={key}
                          className="px-3 py-2 flex items-center justify-between gap-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-7 h-7 rounded-full bg-indigo-500/15 text-indigo-400 text-xs font-bold flex items-center justify-center shrink-0">
                              {initial}
                            </div>
                            <div className="min-w-0">
                              <div className="text-xs font-bold truncate" dir="auto">
                                {label}
                              </div>
                              <div className={`text-[11px] truncate ${t.muted}`} dir="auto">
                                <span dir="ltr" className="font-mono">
                                  {rec.email}
                                </span>
                                {rec.uid ? ' • משתמש NavApp' : ' • ממתין לכניסה'}
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            disabled={isSavingShare}
                            onClick={() => void handleRemoveRecipient(rec)}
                            className={`px-2 py-1 rounded-lg border text-[11px] font-semibold text-red-400 hover:bg-red-500/10 inline-flex items-center gap-1 shrink-0 disabled:opacity-50 ${t.pillBtn}`}
                            title="הסר גישה"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>הסר גישה</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className={`px-4 py-2.5 border-t flex items-center justify-end ${t.divider}`}>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold"
          >
            סגור
          </button>
        </div>
      </div>
    </div>
  );
};
