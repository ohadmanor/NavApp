import React, { useEffect, useRef, useState } from 'react';
import { Cloud, CloudOff, Loader2, LogOut, RefreshCw, X } from 'lucide-react';
import type { NavUser } from '../../core/firebase/AuthService';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface GoogleAccountButtonProps {
  currentUser: NavUser | null;
  firebaseAvailable: boolean;
  isAuthBusy: boolean;
  isOnline: boolean;
  isSyncingCloud?: boolean;
  lastSyncedAt?: string;
  theme: MapTheme;
  mobile?: boolean;
  onSignInGoogle: () => void;
  onSignOutGoogle: () => void;
  onSyncNow?: () => void;
}

const GoogleGIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      fill="#4285F4"
      d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
    />
    <path
      fill="#FBBC05"
      d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
    />
    <path
      fill="#EA4335"
      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
    />
  </svg>
);

function getUserInitial(user: NavUser): string {
  const source = (user.displayName || user.email || 'G').trim();
  return source.charAt(0).toUpperCase();
}

export const GoogleAccountButton: React.FC<GoogleAccountButtonProps> = ({
  currentUser,
  firebaseAvailable,
  isAuthBusy,
  isOnline,
  isSyncingCloud = false,
  lastSyncedAt,
  theme,
  mobile = false,
  onSignInGoogle,
  onSignOutGoogle,
  onSyncNow,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [avatarLoadError, setAvatarLoadError] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const t = getSurfaceTheme(theme);

  useEffect(() => {
    setAvatarLoadError(false);
  }, [currentUser?.photoURL]);

  useEffect(() => {
    if (!currentUser) {
      setIsMenuOpen(false);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const handlePointerDown = (ev: PointerEvent) => {
      if (
        containerRef.current &&
        ev.target instanceof Node &&
        !containerRef.current.contains(ev.target)
      ) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isMenuOpen]);

  const handlePrimaryClick = () => {
    if (isAuthBusy) return;
    if (currentUser) {
      setIsMenuOpen((prev) => !prev);
      return;
    }
    onSignInGoogle();
  };

  const formattedLastSync = lastSyncedAt
    ? (() => {
        const d = new Date(lastSyncedAt);
        return Number.isNaN(d.getTime())
          ? null
          : d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      })()
    : null;

  return (
    <div ref={containerRef} className="relative flex justify-center">
      <button
        type="button"
        onClick={handlePrimaryClick}
        disabled={isAuthBusy}
        data-testid={mobile ? 'google-login-btn-mobile' : 'google-login-btn-desktop'}
        aria-label={
          currentUser
            ? `חשבון Google: ${currentUser.email || currentUser.displayName || 'מחובר'}`
            : 'התחבר לחשבון Google'
        }
        aria-expanded={currentUser ? isMenuOpen : undefined}
        title={
          !firebaseAvailable
            ? 'חיבור Google / Firebase (דורש הגדרת סביבה)'
            : currentUser
              ? `${currentUser.displayName || currentUser.email} • מסנכרן מיקום והגדרות`
              : 'התחבר עם Google לשמירה וסנכרון מיקום והגדרות'
        }
        className={`relative border flex items-center justify-center transition-all ${
          mobile ? 'w-11 h-11 rounded-full shadow-xl' : 'w-10 h-10 rounded-xl shadow-lg'
        } ${
          currentUser
            ? isMenuOpen
              ? 'border-emerald-500 ring-2 ring-emerald-500/40 ' + t.pillBtn
              : 'border-emerald-500/60 ' + t.pillBtn
            : t.pillBtn
        }`}
      >
        {isAuthBusy ? (
          <Loader2 className="w-4 h-4 animate-spin text-sky-500" />
        ) : currentUser ? (
          currentUser.photoURL && !avatarLoadError ? (
            <img
              src={currentUser.photoURL}
              alt={currentUser.displayName || 'Google'}
              referrerPolicy="no-referrer"
              onError={() => setAvatarLoadError(true)}
              className={`${mobile ? 'w-8 h-8' : 'w-7 h-7'} rounded-full object-cover`}
            />
          ) : (
            <span
              className={`${
                mobile ? 'w-8 h-8 text-xs' : 'w-7 h-7 text-[11px]'
              } rounded-full bg-emerald-600 text-white font-bold flex items-center justify-center`}
            >
              {getUserInitial(currentUser)}
            </span>
          )
        ) : (
          <GoogleGIcon className={mobile ? 'w-5 h-5' : 'w-4 h-4'} />
        )}

        {currentUser && (
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 ${
              theme === 'topo-dark' ? 'border-slate-900' : 'border-white'
            } ${isOnline ? 'bg-emerald-500' : 'bg-amber-400'}`}
          />
        )}
      </button>

      {currentUser && isMenuOpen && (
        <div
          dir="rtl"
          className={`absolute bottom-0 ${
            mobile ? 'left-14' : 'left-12'
          } z-50 w-64 max-w-[calc(100vw-80px)] rounded-2xl border p-3.5 space-y-3 ${t.panel}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              {currentUser.photoURL && !avatarLoadError ? (
                <img
                  src={currentUser.photoURL}
                  alt={currentUser.displayName || 'Google'}
                  referrerPolicy="no-referrer"
                  onError={() => setAvatarLoadError(true)}
                  className="w-9 h-9 rounded-full object-cover shrink-0 border border-emerald-500/40"
                />
              ) : (
                <span className="w-9 h-9 rounded-full bg-emerald-600 text-white text-sm font-bold flex items-center justify-center shrink-0">
                  {getUserInitial(currentUser)}
                </span>
              )}
              <div className="min-w-0">
                <div className="text-xs font-bold truncate">
                  {currentUser.displayName || 'משתמש Google'}
                </div>
                <div className={`text-[11px] truncate ${t.muted}`} dir="ltr">
                  {currentUser.email || currentUser.uid}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsMenuOpen(false)}
              className={`p-1 rounded-lg ${t.muted} hover:bg-slate-500/10`}
              title="סגור"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div
            className={`px-2.5 py-2 rounded-xl border text-[11px] flex items-center justify-between gap-2 ${t.subCard}`}
          >
            <span className="flex items-center gap-1.5 font-semibold min-w-0">
              {isOnline ? (
                <Cloud className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              ) : (
                <CloudOff className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              )}
              <span className="truncate">
                {isSyncingCloud
                  ? 'מסנכרן לענן...'
                  : isOnline
                    ? 'סנכרון חוצה פלטפורמות פעיל'
                    : 'מצב אופליין — נשמר מקומית'}
              </span>
            </span>
            {formattedLastSync && (
              <span className={`font-mono text-[10px] shrink-0 ${t.muted}`} dir="ltr">
                {formattedLastSync}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            {onSyncNow && (
              <button
                type="button"
                disabled={!isOnline || isSyncingCloud}
                onClick={() => onSyncNow()}
                className={`w-full py-1.5 px-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-45 ${t.pillBtn}`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncingCloud ? 'animate-spin' : ''}`} />
                <span>סנכרן מיקום והגדרות עכשיו</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                onSignOutGoogle();
              }}
              className="w-full py-1.5 px-2.5 rounded-xl border border-rose-500/35 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>התנתק מחשבון Google</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
