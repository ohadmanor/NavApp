import React, { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  Lock,
  Navigation,
  Radio,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import type { PoiShareRecipient } from '../../core/db/NavDatabase';
import type { NavUser } from '../../core/firebase/AuthService';
import {
  computeDurationExpiry,
  haversineMeters,
  type LiveLocationDurationPreset,
  type LiveLocationRecord,
  type LiveLocationShareConfig,
  type LiveLocationVisibility,
} from '../../core/firebase/LiveLocationCloudService';
import type { LiveGpsFix } from '../../core/navigation/LiveGpsService';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';
import { ShareRecipientsPicker } from './ShareRecipientsPicker';

interface ShareLocationModalProps {
  theme?: MapTheme;
  currentUser: NavUser | null;
  isOnline: boolean;
  firebaseAvailable: boolean;
  isAuthBusy?: boolean;
  hasGpsFix: boolean;
  userLocation: LiveGpsFix | null;
  shareConfig: LiveLocationShareConfig;
  peers: LiveLocationRecord[];
  showPeerLocations: boolean;
  showPublicPeerLocations: boolean;
  onToggleShowPeerLocations: (next: boolean) => void;
  onToggleShowPublicPeerLocations: (next: boolean) => void;
  onSignInGoogle?: () => void | Promise<void>;
  onSaveShareConfig: (next: LiveLocationShareConfig) => void | Promise<void>;
  onStopSharing: () => void | Promise<void>;
  onFocusPeer: (peer: LiveLocationRecord) => void;
  onClose: () => void;
}

const DURATION_OPTIONS: Array<{ id: LiveLocationDurationPreset; label: string }> = [
  { id: '1h', label: 'שעה' },
  { id: '4h', label: '4 שעות' },
  { id: '8h', label: '8 שעות' },
  { id: 'forever', label: 'עד שאפסיק' },
];

function formatDistanceLabel(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} מ׳`;
  return `${(meters / 1000).toFixed(1)} ק״מ`;
}

function formatRemainingTime(expiresAtMs: number | null, nowMs: number): string | null {
  if (expiresAtMs === null) return 'ללא הגבלת זמן';
  const diffMs = Math.max(0, expiresAtMs - nowMs);
  const totalMins = Math.ceil(diffMs / 60000);
  if (totalMins < 60) return `נותרו ${totalMins} דק׳`;
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins > 0 ? `נותרו ${hrs} ש׳ ו-${mins} דק׳` : `נותרו ${hrs} שעות`;
}

export const ShareLocationModal: React.FC<ShareLocationModalProps> = ({
  theme = 'topo-dark',
  currentUser,
  isOnline,
  firebaseAvailable,
  isAuthBusy = false,
  hasGpsFix,
  userLocation,
  shareConfig,
  peers,
  showPeerLocations,
  showPublicPeerLocations,
  onToggleShowPeerLocations,
  onToggleShowPublicPeerLocations,
  onSignInGoogle,
  onSaveShareConfig,
  onStopSharing,
  onFocusPeer,
  onClose,
}) => {
  const t = getSurfaceTheme(theme);
  const [visibility, setVisibility] = useState<LiveLocationVisibility>(shareConfig.visibility);
  const [sharedWith, setSharedWith] = useState<PoiShareRecipient[]>(shareConfig.sharedWith);
  const [durationPreset, setDurationPreset] = useState<LiveLocationDurationPreset>(
    shareConfig.durationPreset
  );
  const [isSaving, setIsSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setVisibility(shareConfig.visibility);
    setSharedWith(shareConfig.sharedWith);
    setDurationPreset(shareConfig.durationPreset);
  }, [shareConfig]);

  useEffect(() => {
    if (shareConfig.visibility === 'off') return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [shareConfig.visibility]);

  const isCurrentlyActive = shareConfig.visibility !== 'off';
  const remainingLabel = useMemo(
    () => (isCurrentlyActive ? formatRemainingTime(shareConfig.expiresAtMs, nowMs) : null),
    [isCurrentlyActive, shareConfig.expiresAtMs, nowMs]
  );

  const handleApplySharing = async (
    nextVisibility = visibility,
    nextRecipients = sharedWith,
    nextPreset = durationPreset
  ) => {
    setStatusError(null);
    if (nextVisibility === 'off') {
      setIsSaving(true);
      try {
        await onStopSharing();
      } finally {
        setIsSaving(false);
      }
      return;
    }
    if (nextVisibility === 'shared' && nextRecipients.length === 0) {
      setStatusError('בחר לפחות משתמש אחד לשיתוף, או בחר במצב "כל משתמשי NavApp".');
      return;
    }

    const now = Date.now();
    const { expiresAt, expiresAtMs } = computeDurationExpiry(nextPreset, now);
    setIsSaving(true);
    try {
      await onSaveShareConfig({
        visibility: nextVisibility,
        sharedWith: nextRecipients,
        durationPreset: nextPreset,
        startedAt: isCurrentlyActive ? shareConfig.startedAt : new Date(now).toISOString(),
        expiresAt,
        expiresAtMs,
      });
    } catch (err: any) {
      setStatusError(err?.message || 'שגיאה בהפעלת שיתוף המיקום');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddRecipient = async (recipient: PoiShareRecipient) => {
    const next = [...sharedWith, recipient];
    setSharedWith(next);
    setStatusError(null);
    if (shareConfig.visibility === 'shared') {
      await handleApplySharing('shared', next, durationPreset);
    }
  };

  const handleRemoveRecipient = async (recipient: PoiShareRecipient) => {
    const emailLower = recipient.email.trim().toLowerCase();
    const next = sharedWith.filter(
      (r) =>
        !(
          (recipient.uid && r.uid === recipient.uid) ||
          (emailLower && r.email.trim().toLowerCase() === emailLower)
        )
    );
    setSharedWith(next);
    if (shareConfig.visibility === 'shared') {
      if (next.length === 0) {
        await handleApplySharing('off', [], durationPreset);
        setVisibility('off');
      } else {
        await handleApplySharing('shared', next, durationPreset);
      }
    }
  };

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden flex flex-col max-h-[88vh] ${t.panel}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-500/20">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                isCurrentlyActive
                  ? 'bg-red-500/15 text-red-500 ring-2 ring-red-500/50'
                  : 'bg-sky-500/15 text-sky-500'
              }`}
            >
              <Radio className={`w-5 h-5 ${isCurrentlyActive ? 'animate-pulse' : ''}`} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold truncate">שיתוף מיקום חי (Live)</h2>
              <p className={`text-[11px] truncate ${t.muted}`}>
                {isCurrentlyActive
                  ? `פעיל • ${
                      shareConfig.visibility === 'public' ? 'גלוי לכל המשתמשים' : `${shareConfig.sharedWith.length} נבחרים`
                    }${remainingLabel ? ` • ${remainingLabel}` : ''}`
                  : 'המיקום שלך פרטי כרגע'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-500/15 transition-colors"
            aria-label="סגור"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 overflow-y-auto">
          {!firebaseAvailable || !currentUser ? (
            <div className={`p-3.5 rounded-xl border space-y-3 ${t.subCard}`}>
              <p className="text-xs leading-relaxed">
                כדי לשתף את המיקום החי שלך או לראות משתמשים אחרים על המפה, יש להתחבר לחשבון Google.
              </p>
              {onSignInGoogle && (
                <button
                  type="button"
                  disabled={isAuthBusy || !firebaseAvailable}
                  onClick={() => void onSignInGoogle()}
                  className="w-full py-2.5 px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                >
                  {isAuthBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  התחבר עם Google
                </button>
              )}
            </div>
          ) : (
            <>
              {!isOnline && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-500 text-xs">
                  <WifiOff className="w-4 h-4 shrink-0" />
                  <span>אין חיבור אינטרנט כרגע — עדכוני מיקום יישלחו עם החזרה לרשת.</span>
                </div>
              )}

              {!hasGpsFix && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-400 text-xs">
                  <Navigation className="w-4 h-4 shrink-0 animate-pulse" />
                  <span>ממתין לאות GPS — השיתוף יתחיל לשדר מיד עם קליטת המיקום.</span>
                </div>
              )}

              {isCurrentlyActive && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/35 text-xs">
                  <span className="text-red-400 font-medium">
                    האייקון שלך על המפה מסומן במסגרת אדומה בזמן השיתוף.
                  </span>
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => {
                      setVisibility('off');
                      void handleApplySharing('off');
                    }}
                    className="px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold shrink-0 transition-colors"
                  >
                    הפסק שיתוף
                  </button>
                </div>
              )}

              {/* Audience selector */}
              <div className="space-y-1.5">
                <label className={`text-xs font-bold block ${t.muted}`}>עם מי לשתף?</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { id: 'off' as const, label: 'כבוי', Icon: Lock },
                    { id: 'shared' as const, label: 'משתמשים נבחרים', Icon: Users },
                    { id: 'public' as const, label: 'כל המשתמשים', Icon: Globe },
                  ].map(({ id, label, Icon }) => {
                    const active = visibility === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          setVisibility(id);
                          setStatusError(null);
                        }}
                        className={`px-2 py-2 rounded-xl border text-[11px] font-bold flex flex-col items-center gap-1 transition-all ${
                          active
                            ? id === 'off'
                              ? 'border-slate-400 bg-slate-500/20'
                              : 'border-red-500 bg-red-500/15 text-red-400'
                            : t.subCard
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                        <span className="text-center leading-tight">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {visibility === 'shared' && (
                <div className="space-y-2">
                  <ShareRecipientsPicker
                    theme={theme}
                    currentUser={currentUser}
                    isOnline={isOnline}
                    firebaseAvailable={firebaseAvailable}
                    recipients={sharedWith}
                    isBusy={isSaving}
                    emptyText="הוסף משתמשי NavApp לפי שם או כתובת Gmail כדי לשתף איתם מיקום חי."
                    inputId="share-location-recipient-input"
                    onAddRecipient={handleAddRecipient}
                    onRemoveRecipient={handleRemoveRecipient}
                  />
                </div>
              )}

              {visibility === 'public' && (
                <div className="px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400 leading-relaxed">
                  במצב <strong>כל משתמשי NavApp</strong>, המיקום החי ושם התצוגה שלך יהיו גלויים על המפה לכל משתמש מחובר באפליקציה.
                </div>
              )}

              {visibility !== 'off' && (
                <div className="space-y-1.5">
                  <label className={`text-xs font-bold flex items-center gap-1.5 ${t.muted}`}>
                    <Clock className="w-3.5 h-3.5" />
                    <span>משך השיתוף</span>
                  </label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {DURATION_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setDurationPreset(opt.id)}
                        className={`py-1.5 px-2 rounded-xl border text-[11px] font-bold transition-colors ${
                          durationPreset === opt.id
                            ? 'border-sky-500 bg-sky-500/15 text-sky-400'
                            : t.subCard
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {statusError && (
                <div className="px-3 py-2 rounded-xl bg-red-500/15 border border-red-500/40 text-red-400 text-xs">
                  {statusError}
                </div>
              )}

              <button
                type="button"
                disabled={isSaving}
                onClick={() => void handleApplySharing()}
                className={`w-full py-2.5 px-4 rounded-xl text-xs font-bold text-white flex items-center justify-center gap-2 transition-colors disabled:opacity-50 ${
                  visibility === 'off'
                    ? 'bg-slate-600 hover:bg-slate-500'
                    : 'bg-red-600 hover:bg-red-500'
                }`}
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
                <span>
                  {visibility === 'off'
                    ? isCurrentlyActive
                      ? 'הפסק שיתוף מיקום'
                      : 'שמור כפרטי'
                    : isCurrentlyActive
                      ? 'עדכן הגדרות שיתוף'
                      : 'התחל שיתוף מיקום חי'}
                </span>
              </button>

              {/* Map visibility & Active peers */}
              <div className="pt-2 border-t border-slate-500/20 space-y-2.5">
                <div className="text-xs font-bold">מיקומים על המפה</div>

                <button
                  type="button"
                  onClick={() => onToggleShowPeerLocations(!showPeerLocations)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl border text-xs ${t.subCard}`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {showPeerLocations ? <Eye className="w-4 h-4 text-emerald-500" /> : <EyeOff className="w-4 h-4 opacity-60" />}
                    <span>הצג מיקומי משתמשים על המפה</span>
                  </span>
                  <span
                    className={`w-9 h-5 rounded-full p-0.5 transition-colors flex items-center ${
                      showPeerLocations ? 'bg-emerald-600 justify-start' : 'bg-slate-400/40 justify-end'
                    }`}
                  >
                    <span className="w-4 h-4 rounded-full bg-white shadow" />
                  </span>
                </button>

                {showPeerLocations && (
                  <button
                    type="button"
                    onClick={() => onToggleShowPublicPeerLocations(!showPublicPeerLocations)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-xl border text-xs ${t.subCard}`}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <Globe className="w-4 h-4 text-sky-400" />
                      <span>כלול שיתופים ציבוריים (כל המשתמשים)</span>
                    </span>
                    <span
                      className={`w-9 h-5 rounded-full p-0.5 transition-colors flex items-center ${
                        showPublicPeerLocations ? 'bg-sky-600 justify-start' : 'bg-slate-400/40 justify-end'
                      }`}
                    >
                      <span className="w-4 h-4 rounded-full bg-white shadow" />
                    </span>
                  </button>
                )}

                {showPeerLocations && (
                  <div className="space-y-1.5">
                    <div className={`text-[11px] font-medium ${t.muted}`}>
                      משתמשים פעילים כרגע ({peers.length})
                    </div>
                    {peers.length === 0 ? (
                      <div className={`text-xs px-3 py-2.5 rounded-xl border ${t.subCard} ${t.muted}`}>
                        אין כרגע משתמשים אחרים שמשתפים איתך מיקום.
                      </div>
                    ) : (
                      <div className="space-y-1 max-h-36 overflow-y-auto">
                        {peers.map((peer) => {
                          const dist = userLocation
                            ? haversineMeters(userLocation.lon, userLocation.lat, peer.lon, peer.lat)
                            : null;
                          return (
                            <button
                              key={peer.uid}
                              type="button"
                              onClick={() => {
                                onFocusPeer(peer);
                                onClose();
                              }}
                              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl border text-xs hover:border-sky-500/60 transition-colors ${t.subCard}`}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="w-2.5 h-2.5 rounded-full shrink-0"
                                  style={{ backgroundColor: peer.accentColor || '#0ea5e9' }}
                                />
                                <span className="font-bold truncate">{peer.displayName}</span>
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded-md ${
                                    peer.visibility === 'public'
                                      ? 'bg-sky-500/15 text-sky-400'
                                      : 'bg-emerald-500/15 text-emerald-400'
                                  }`}
                                >
                                  {peer.visibility === 'public' ? 'ציבורי' : 'משותף'}
                                </span>
                              </div>
                              {dist !== null && (
                                <span className={`text-[11px] font-mono shrink-0 ${t.muted}`}>
                                  {formatDistanceLabel(dist)}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
