import React, { useState } from 'react';
import { X, Crosshair, Check, Lock, LogIn, Globe, Users, ChevronDown } from 'lucide-react';
import {
  db,
  type PoiCategory,
  type PoiRecord,
  type PoiShareRecipient,
  type PoiVisibility,
} from '../../core/db/NavDatabase';
import type { NavUser } from '../../core/firebase/AuthService';
import { GlobalPoiCloudService } from '../../core/firebase/GlobalPoiCloudService';
import {
  PrivatePoiCloudService,
  normalizePoiShareRecipients,
} from '../../core/firebase/PrivatePoiCloudService';
import { canUserAddOrEditPoi } from '../../core/pois/poiPermissions';
import { PoiManager } from '../../core/pois/PoiManager';
import {
  POI_CATEGORIES,
  POI_CATEGORY_SPECS,
  POI_SYMBOLS_BY_CATEGORY,
} from '../../core/pois/poiTaxonomy';
import { ElevationService } from '../../core/navigation/ElevationService';
import { MilitaryGridService } from '../../core/navigation/MilitaryGridService';
import { ShareRecipientsPicker } from '../sharing/ShareRecipientsPicker';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';
import { PoiCategoryIcon } from './PoiCategoryIcon';

interface AddPoiPanelProps {
  theme: MapTheme;
  centerCoords: { lon: number; lat: number; ele: number | null };
  currentUser: NavUser | null;
  isOnline?: boolean;
  firebaseAvailable?: boolean;
  isAuthBusy?: boolean;
  onSignInGoogle?: () => void;
  onClose: () => void;
  onCreated: (poi: PoiRecord, meta?: { queuedOffline?: boolean }) => void;
}

export const AddPoiPanel: React.FC<AddPoiPanelProps> = ({
  theme,
  centerCoords,
  currentUser,
  isOnline = true,
  firebaseAvailable = true,
  isAuthBusy = false,
  onSignInGoogle,
  onClose,
  onCreated,
}) => {
  const [category, setCategory] = useState<PoiCategory>('water');
  const [subcategory, setSubcategory] = useState<string>(POI_CATEGORY_SPECS.water.defaultSubcategory);
  const [nameHe, setNameHe] = useState('');
  const [descHe, setDescHe] = useState('');
  const [poiVisibility, setPoiVisibility] = useState<PoiVisibility>('private');
  const [showSharePicker, setShowSharePicker] = useState(false);
  const [shareRecipients, setShareRecipients] = useState<PoiShareRecipient[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const t = getSurfaceTheme(theme);
  const canAdd = canUserAddOrEditPoi(currentUser);
  const milCoords = MilitaryGridService.toMilitaryCoords(centerCoords.lon, centerCoords.lat);
  const categorySymbols = POI_SYMBOLS_BY_CATEGORY[category] || [];

  const handleSelectCategory = (nextCat: PoiCategory) => {
    setCategory(nextCat);
    setSubcategory(POI_CATEGORY_SPECS[nextCat].defaultSubcategory);
  };

  const handleAddDraftRecipient = (recipient: PoiShareRecipient) => {
    const emailLower = recipient.email.trim().toLowerCase();
    setShareRecipients((prev) => {
      if (
        prev.some(
          (r) =>
            (recipient.uid && r.uid === recipient.uid) ||
            (emailLower && r.email.trim().toLowerCase() === emailLower)
        )
      ) {
        return prev;
      }
      return [...prev, recipient];
    });
  };

  const handleRemoveDraftRecipient = (target: PoiShareRecipient) => {
    const targetEmail = target.email.trim().toLowerCase();
    setShareRecipients((prev) =>
      prev.filter(
        (r) =>
          !(
            (target.uid && r.uid && r.uid === target.uid) ||
            (targetEmail && r.email.trim().toLowerCase() === targetEmail)
          )
      )
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canAdd || !currentUser || !nameHe.trim() || isSaving) return;
    setIsSaving(true);
    setErrorMsg(null);
    let createdLocally: PoiRecord | null = null;
    try {
      const ele =
        centerCoords.ele ??
        (await ElevationService.getElevationAt(centerCoords.lon, centerCoords.lat, 12));
      const normalizedShare =
        poiVisibility === 'private'
          ? normalizePoiShareRecipients(shareRecipients)
          : { sharedWith: [], sharedWithUids: [], sharedWithEmails: [] };

      createdLocally = await PoiManager.addCustomUserPoi({
        nameHe: nameHe.trim(),
        category,
        subcategory,
        lon: centerCoords.lon,
        lat: centerCoords.lat,
        ele,
        descHe: descHe.trim() || 'נקודת עניין שדווחה בשטח',
        visibility: poiVisibility,
        createdByUid: currentUser.uid,
        ownerUid: currentUser.uid,
        ownerEmail: currentUser.email,
        ownerDisplayName: currentUser.displayName,
        ...(poiVisibility === 'private'
          ? {
              sharedWith: normalizedShare.sharedWith,
              sharedWithUids: normalizedShare.sharedWithUids,
              sharedWithEmails: normalizedShare.sharedWithEmails,
            }
          : {}),
      });

      const cloudRes =
        poiVisibility === 'private'
          ? await PrivatePoiCloudService.publishPrivatePoi(createdLocally, currentUser)
          : await GlobalPoiCloudService.publishUserPoi(createdLocally, currentUser);
      onCreated(createdLocally, { queuedOffline: cloudRes.queuedOffline });
    } catch (err: any) {
      if (createdLocally) {
        await db.pois.delete(createdLocally.id).catch(() => undefined);
      }
      setErrorMsg(
        err?.message ||
          (poiVisibility === 'private'
            ? 'שמירת הנקודה הפרטית נכשלה'
            : 'שמירת הנקודה במפה הגלובלית נכשלה')
      );
    } finally {
      setIsSaving(false);
    }
  };

  if (!canAdd) {
    return (
      <div dir="rtl" className="p-4 space-y-3 overflow-y-auto">
        <div className="flex items-start justify-between gap-2">
          <div>
            <span className="text-xs font-bold text-sky-500 flex items-center gap-1">
              <Lock className="w-3.5 h-3.5" />
              <span>נדרשת התחברות</span>
            </span>
            <h3 className="text-base font-bold mt-0.5">דווח נקודת עניין בשטח</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`p-1.5 rounded-lg border ${t.pillBtn}`}
            title="סגור"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className={`p-3 rounded-xl border text-xs leading-relaxed space-y-2 ${t.subCard}`}>
          <p className="font-semibold">
            הוספת נקודת עניין פתוחה למשתמשים מחוברים בלבד. כברירת מחדל הנקודות נשמרות באופן פרטי בחשבונך, וניתן לשתף אותן עם חברים או להפוך לגלובליות.
          </p>
          {onSignInGoogle && (
            <button
              type="button"
              disabled={isAuthBusy}
              onClick={onSignInGoogle}
              className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-colors"
            >
              <LogIn className="w-4 h-4" />
              <span>{isAuthBusy ? 'מתחבר...' : 'התחבר עם Google כדי להוסיף נקודה'}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form dir="rtl" onSubmit={handleSubmit} className="p-4 space-y-3 overflow-y-auto">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-xs font-bold text-sky-500 flex items-center gap-1">
            <Crosshair className="w-3.5 h-3.5" />
            <span>הזז את המפה למיקום הרצוי מתחת לצלב</span>
          </span>
          <h3 className="text-base font-bold mt-0.5">דווח נקודת עניין בשטח</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`p-1.5 rounded-lg border ${t.pillBtn}`}
          title="סגור"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Live Target Coordinate Readout */}
      <div
        className={`p-2.5 rounded-xl border flex items-center justify-between text-xs font-mono ${t.subCard}`}
      >
        <span className="text-amber-500 font-bold">
          נ.צ. <span dir="ltr">{milCoords.idfGrid8Digit}</span>
        </span>
        <span className="text-emerald-500 font-bold">
          גובה: {centerCoords.ele !== null ? `${centerCoords.ele}m` : '---'}
        </span>
      </div>

      {/* Category Selector (6 Exclusive Categories) */}
      <div className="grid grid-cols-3 gap-1.5">
        {POI_CATEGORIES.map((catId) => {
          const spec = POI_CATEGORY_SPECS[catId];
          const active = category === catId;
          return (
            <button
              key={catId}
              type="button"
              onClick={() => handleSelectCategory(catId)}
              className={`py-2 px-1.5 rounded-xl border text-xs font-bold transition-all flex items-center justify-center gap-1.5 truncate ${
                active ? spec.activeClass : t.subCard
              }`}
            >
              <PoiCategoryIcon category={catId} size={18} />
              <span className="truncate">{spec.shortLabelHe}</span>
            </button>
          );
        })}
      </div>

      {/* Exclusive Symbol Selector within selected Category */}
      <div className="flex flex-wrap gap-1.5">
        {categorySymbols.map((sym) => {
          const active = subcategory === sym.subcategory;
          return (
            <button
              key={sym.id}
              type="button"
              onClick={() => setSubcategory(sym.subcategory)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-all ${
                active
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-500'
                  : t.pillBtn
              }`}
            >
              <PoiCategoryIcon category={category} subcategory={sym.subcategory} size={15} />
              <span>{sym.labelHe}</span>
            </button>
          );
        })}
      </div>

      <input
        id="add-poi-name"
        name="poiName"
        type="text"
        dir="auto"
        required
        value={nameHe}
        onChange={(e) => setNameHe(e.target.value)}
        placeholder="שם הנקודה (לדוגמה: גב מים מלא / מדרגת סלע)"
        className={`w-full rounded-xl border px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 ${t.fieldBox}`}
      />

      <input
        id="add-poi-desc"
        name="poiDesc"
        type="text"
        dir="auto"
        value={descHe}
        onChange={(e) => setDescHe(e.target.value)}
        placeholder="תיאור או הערת עבירות/מים למטיילים..."
        className={`w-full rounded-xl border px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 ${t.fieldBox}`}
      />

      {/* Visibility Selector (Private by default vs Global) */}
      <div className={`p-2.5 rounded-xl border space-y-2 ${t.subCard}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold">פרטיות וחשיפה במפה</span>
          <span className={`text-[11px] ${t.muted}`}>
            {poiVisibility === 'private' ? 'ברירת מחדל: פרטי' : 'פתוח לכולם'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="חשיפת נקודת עניין">
          <button
            type="button"
            role="radio"
            aria-checked={poiVisibility === 'private'}
            onClick={() => setPoiVisibility('private')}
            className={`py-2 px-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
              poiVisibility === 'private'
                ? 'border-indigo-500 bg-indigo-500/15 text-indigo-400'
                : t.pillBtn
            }`}
          >
            <Lock className="w-3.5 h-3.5" />
            <span>פרטי (רק אני)</span>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={poiVisibility === 'global'}
            onClick={() => {
              setPoiVisibility('global');
              setShowSharePicker(false);
            }}
            className={`py-2 px-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
              poiVisibility === 'global'
                ? 'border-emerald-500 bg-emerald-500/15 text-emerald-500'
                : t.pillBtn
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>גלובלי (לכולם)</span>
          </button>
        </div>

        <p className={`text-[11px] leading-relaxed ${t.muted}`}>
          {poiVisibility === 'private'
            ? 'הנקודה תישמר בחשבונך בלבד. תוכל לשתף אותה עם משתמשים נבחרים או להפוך לגלובלית בכל עת.'
            : 'הנקודה תפורסם במפה הגלובלית ותהיה גלויה לכל משתמשי NavApp.'}
        </p>

        {poiVisibility === 'private' && (
          <div className={`pt-1.5 border-t space-y-2 ${t.divider}`}>
            <button
              type="button"
              onClick={() => setShowSharePicker((prev) => !prev)}
              className={`w-full py-1.5 px-2.5 rounded-lg border text-xs font-semibold flex items-center justify-between gap-2 ${t.pillBtn}`}
            >
              <span className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-indigo-400" />
                <span>
                  שתף עם משתמשים{shareRecipients.length > 0 ? ` (${shareRecipients.length})` : ' (אופציונלי)'}
                </span>
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${showSharePicker ? 'rotate-180' : ''}`}
              />
            </button>

            {showSharePicker && (
              <ShareRecipientsPicker
                theme={theme}
                currentUser={currentUser}
                isOnline={isOnline}
                firebaseAvailable={firebaseAvailable}
                recipients={shareRecipients}
                isBusy={isSaving}
                emptyText="עדיין לא נבחרו נמענים — הנקודה תישמר עבורך בלבד."
                selfShareErrorText="לא ניתן לשתף נקודה פרטית עם עצמך."
                inputId="add-poi-share-recipient-input"
                onAddRecipient={handleAddDraftRecipient}
                onRemoveRecipient={handleRemoveDraftRecipient}
              />
            )}
          </div>
        )}
      </div>

      {errorMsg && (
        <p className="text-xs font-semibold text-rose-500" role="alert">
          {errorMsg}
        </p>
      )}

      <button
        type="submit"
        disabled={isSaving || !nameHe.trim()}
        className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-colors"
      >
        <Check className="w-4 h-4" />
        <span>
          {isSaving
            ? 'שומר...'
            : poiVisibility === 'private'
              ? shareRecipients.length > 0
                ? `שמור נקודה פרטית ושתף (${shareRecipients.length})`
                : 'שמור נקודה פרטית'
              : 'שמור נקודה במפה הגלובלית'}
        </span>
      </button>
    </form>
  );
};
