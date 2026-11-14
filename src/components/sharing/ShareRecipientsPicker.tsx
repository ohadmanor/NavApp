import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Loader2,
  Mail,
  Plus,
  Search,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import type { PoiShareRecipient } from '../../core/db/NavDatabase';
import type { NavUser } from '../../core/firebase/AuthService';
import {
  UserDirectoryService,
  type AppDirectoryUser,
} from '../../core/firebase/UserDirectoryService';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

interface ShareRecipientsPickerProps {
  theme: MapTheme;
  currentUser: NavUser | null;
  isOnline: boolean;
  firebaseAvailable: boolean;
  recipients: PoiShareRecipient[];
  isBusy?: boolean;
  emptyText?: string;
  selfShareErrorText?: string;
  inputId?: string;
  autoFocus?: boolean;
  onAddRecipient: (recipient: PoiShareRecipient, label: string) => void | Promise<void>;
  onRemoveRecipient: (recipient: PoiShareRecipient) => void | Promise<void>;
}

/**
 * Shared recipient autocomplete & management widget backed by UserDirectoryService (/users/{uid}),
 * supporting both registered NavApp users (displayName / Gmail) and pending Gmail invites.
 */
export const ShareRecipientsPicker: React.FC<ShareRecipientsPickerProps> = ({
  theme,
  currentUser,
  isOnline,
  firebaseAvailable,
  recipients,
  isBusy = false,
  emptyText = 'פריט זה פרטי כרגע ואינו משותף עם משתמשים אחרים.',
  selfShareErrorText = 'לא ניתן לשתף עם עצמך.',
  inputId = 'share-poi-recipient-input',
  autoFocus = false,
  onAddRecipient,
  onRemoveRecipient,
}) => {
  const t = getSurfaceTheme(theme);
  const [queryText, setQueryText] = useState('');
  const [suggestions, setSuggestions] = useState<AppDirectoryUser[]>([]);
  const [isSearchingUsers, setIsSearchingUsers] = useState(false);

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

  const handlePickDirectoryUser = async (userItem: AppDirectoryUser) => {
    if (isBusy || alreadyHasRecipient(userItem)) return;
    const nextRecipient: PoiShareRecipient = {
      uid: userItem.uid,
      email: userItem.emailLower || userItem.email.toLowerCase(),
      displayName: userItem.displayName,
      photoURL: userItem.photoURL || null,
      sharedAt: new Date().toISOString(),
    };
    setQueryText('');
    setSuggestions([]);
    await onAddRecipient(nextRecipient, userItem.displayName || userItem.email);
  };

  const handleInviteEmail = async () => {
    if (!canInviteTypedEmail || !normalizedTypedEmail || isBusy) return;
    const nextRecipient: PoiShareRecipient = {
      uid: null,
      email: normalizedTypedEmail,
      displayName: null,
      photoURL: null,
      sharedAt: new Date().toISOString(),
    };
    setQueryText('');
    setSuggestions([]);
    await onAddRecipient(nextRecipient, normalizedTypedEmail);
  };

  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <label htmlFor={inputId} className={`block text-xs font-bold ${t.muted}`}>
          הוסף משתמש לפי שם או כתובת Gmail
        </label>
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-xl border focus-within:border-indigo-500 ${t.fieldBox}`}
        >
          <Search className={`w-4 h-4 shrink-0 ${t.muted}`} />
          <input
            id={inputId}
            name="sharePoiRecipient"
            type="text"
            dir="auto"
            autoFocus={autoFocus}
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (canInviteTypedEmail) {
                  void handleInviteEmail();
                }
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
                      disabled={isBusy}
                      onClick={() => void handlePickDirectoryUser(u)}
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
                  disabled={isBusy}
                  onClick={() => void handleInviteEmail()}
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
                ? selfShareErrorText
                : normalizedTypedEmail && alreadyHasRecipient({ email: normalizedTypedEmail })
                  ? 'משתמש זה כבר נמצא ברשימת השיתוף.'
                  : !isOnline
                    ? 'במצב אופליין ניתן להוסיף נמען לפי כתובת Gmail מלאה.'
                    : 'לא נמצאו משתמשים תואמים. ניתן להזין כתובת Gmail מלאה.'}
            </p>
          )}
      </div>

      {/* Current Recipients */}
      <div className="space-y-1.5">
        <span className={`block text-xs font-bold ${t.muted}`}>
          שותף עם ({recipients.length})
        </span>
        {recipients.length === 0 ? (
          <div className={`p-3 rounded-xl border border-dashed text-center text-xs ${t.muted} ${t.subCard}`}>
            {emptyText}
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
                    disabled={isBusy}
                    onClick={() => void onRemoveRecipient(rec)}
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
    </div>
  );
};
