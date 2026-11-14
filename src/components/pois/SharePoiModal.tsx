import React, { useEffect, useState } from 'react';
import { Check, Loader2, Share2, Users, WifiOff, X } from 'lucide-react';
import type { PoiRecord, PoiShareRecipient } from '../../core/db/NavDatabase';
import type { NavUser } from '../../core/firebase/AuthService';
import { ShareRecipientsPicker } from '../sharing/ShareRecipientsPicker';
import { PoiCategoryIcon } from './PoiCategoryIcon';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface SharePoiModalProps {
  poi: PoiRecord;
  theme?: MapTheme;
  currentUser: NavUser | null;
  isOnline: boolean;
  firebaseAvailable: boolean;
  isAuthBusy?: boolean;
  onSignInGoogle?: () => void | Promise<void>;
  onUpdateRecipients: (
    poi: PoiRecord,
    nextRecipients: PoiShareRecipient[]
  ) => Promise<{ synced: boolean; queuedOffline?: boolean; poi: PoiRecord; error?: string }>;
  onClose: () => void;
}

export const SharePoiModal: React.FC<SharePoiModalProps> = ({
  poi,
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
  const [recipients, setRecipients] = useState<PoiShareRecipient[]>(poi.sharedWith || []);
  const [isSavingShare, setIsSavingShare] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  useEffect(() => {
    setRecipients(poi.sharedWith || []);
  }, [poi.id, poi.sharedWith]);

  const applyRecipientsUpdate = async (
    nextList: PoiShareRecipient[],
    successMsg: string
  ) => {
    setIsSavingShare(true);
    setStatusError(null);
    setStatusNote(null);
    try {
      const res = await onUpdateRecipients(poi, nextList);
      setRecipients(res.poi.sharedWith || nextList);
      if (res.synced) {
        setStatusNote(successMsg);
      } else {
        setStatusError(
          res.error ||
            'השינוי נשמר במכשיר ויסתנכרן לענן ברגע שיתאפשר חיבור.'
        );
      }
    } catch (err: any) {
      setStatusError(err?.message || 'שגיאה בעדכון שיתוף נקודת העניין');
    } finally {
      setIsSavingShare(false);
    }
  };

  const handleAddRecipient = async (nextRecipient: PoiShareRecipient, label: string) => {
    const nextList = [...recipients, nextRecipient];
    await applyRecipientsUpdate(
      nextList,
      nextRecipient.uid
        ? `הנקודה שותפה עם ${label}`
        : `נשלחה הזמנת שיתוף אל ${label}`
    );
  };

  const handleRemoveRecipient = async (target: PoiShareRecipient) => {
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
      aria-label={`שיתוף נקודת עניין ${poi.nameHe || poi.name}`}
      onClick={onClose}
    >
      <div
        dir="rtl"
        className={`w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden flex flex-col max-h-[85vh] ${t.panelSolid}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`px-4 py-3 border-b flex items-center justify-between gap-2 ${t.divider}`}>
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center shrink-0">
              <Share2 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold truncate flex items-center gap-1.5" dir="auto">
                <PoiCategoryIcon category={poi.category} subcategory={poi.subcategory} size={16} />
                <span className="truncate">שיתוף נקודה פרטית: {poi.nameHe || poi.name}</span>
              </h3>
              <div className={`text-[11px] ${t.muted}`}>
                רק משתמשים ברשימה יראו נקודה זו על המפה
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

        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          {!firebaseAvailable ? (
            <div className={`p-3 rounded-xl border text-xs ${t.subCard}`}>
              שירותי הענן של Firebase אינם מוגדרים בסביבה זו.
            </div>
          ) : !currentUser ? (
            <div className={`p-4 rounded-xl border text-center space-y-3 ${t.subCard}`}>
              <Users className="w-7 h-7 text-indigo-400 mx-auto" />
              <div className="text-xs font-bold">התחברות נדרשת לשיתוף נקודות עניין</div>
              <p className={`text-xs ${t.muted}`}>
                התחבר עם חשבון Google שלך כדי לשתף נקודה פרטית לפי שם משתמש ב-NavApp או כתובת Gmail.
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

              <ShareRecipientsPicker
                theme={theme}
                currentUser={currentUser}
                isOnline={isOnline}
                firebaseAvailable={firebaseAvailable}
                recipients={recipients}
                isBusy={isSavingShare}
                emptyText="נקודה זו פרטית כרגע ואינה משותפת עם משתמשים אחרים."
                selfShareErrorText="לא ניתן לשתף נקודה פרטית עם עצמך."
                inputId="share-poi-recipient-input"
                autoFocus
                onAddRecipient={handleAddRecipient}
                onRemoveRecipient={handleRemoveRecipient}
              />

              {isSavingShare && (
                <div className="px-3 py-2 rounded-xl border border-indigo-500/40 bg-indigo-500/10 text-indigo-400 text-xs flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>מעדכן הרשאות שיתוף בענן...</span>
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
            </>
          )}
        </div>

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
