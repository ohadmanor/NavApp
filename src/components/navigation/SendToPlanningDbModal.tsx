import React, { useEffect, useState } from 'react';
import { FolderPlus, X, FolderTree } from 'lucide-react';
import type { PlanningFolderRecord, SavedRouteRecord } from '../../core/db/NavDatabase';
import {
  TRAIL_CATEGORY_META,
  TRAIL_CATEGORY_ORDER,
  TRAIL_DIFFICULTY_META,
  TRAIL_DIFFICULTY_ORDER,
  inferDefaultCategoryFromPlanningMode,
  type TrailCategoryId,
  type TrailDifficulty,
} from '../../core/navigation/PlanningTrailTaxonomy';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface SendToPlanningDbModalProps {
  isOpen: boolean;
  theme: MapTheme;
  route: SavedRouteRecord | null;
  folders: PlanningFolderRecord[];
  onClose: () => void;
  onCreateFolder: (name: string, parentId: string | null) => Promise<PlanningFolderRecord | undefined>;
  onConfirm: (options: {
    folderId: string | null;
    categoryId: TrailCategoryId;
    difficulty: TrailDifficulty;
    tags: string[];
  }) => Promise<void>;
}

function buildIndentedFolderOptions(
  folders: PlanningFolderRecord[],
  parentId: string | null = null,
  depth = 0
): Array<{ id: string; label: string }> {
  const result: Array<{ id: string; label: string }> = [];
  const children = folders
    .filter((f) => (f.parentId ?? null) === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'he'));
  for (const f of children) {
    result.push({ id: f.id, label: `${'— '.repeat(depth)}${f.name}` });
    result.push(...buildIndentedFolderOptions(folders, f.id, depth + 1));
  }
  return result;
}

export const SendToPlanningDbModal: React.FC<SendToPlanningDbModalProps> = ({
  isOpen,
  theme,
  route,
  folders,
  onClose,
  onCreateFolder,
  onConfirm,
}) => {
  const surface = getSurfaceTheme(theme);
  const [folderId, setFolderId] = useState<string>('');
  const [categoryId, setCategoryId] = useState<TrailCategoryId>('4x4');
  const [difficulty, setDifficulty] = useState<TrailDifficulty>('medium');
  const [tagsText, setTagsText] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen || !route) return;
    setCategoryId(inferDefaultCategoryFromPlanningMode(route.planningMode));
    setDifficulty('medium');
    setTagsText('');
    setIsCreatingFolder(false);
    setNewFolderName('');
  }, [isOpen, route]);

  if (!isOpen || !route) return null;

  const folderOptions = buildIndentedFolderOptions(folders);

  const handleInlineCreateFolder = async () => {
    const clean = newFolderName.trim();
    if (!clean) return;
    const created = await onCreateFolder(clean, folderId || null);
    if (created) {
      setFolderId(created.id);
      setNewFolderName('');
      setIsCreatingFolder(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const tags = tagsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await onConfirm({
        folderId: folderId || null,
        categoryId,
        difficulty,
        tags,
      });
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      dir="rtl"
    >
      <form
        onSubmit={handleSubmit}
        className={`w-full max-w-md rounded-2xl border p-5 space-y-4 ${surface.panelSolid}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderTree className="w-5 h-5 text-emerald-500" />
            <h3 className="text-base font-bold">שליחה למאגר תכנון מסלולים</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`p-1.5 rounded-lg ${surface.hoverRow}`}
            aria-label="סגור"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className={`rounded-xl border px-3 py-2 text-xs ${surface.subCard}`}>
          <div className="font-bold truncate">{route.name}</div>
          <div className={`text-[11px] mt-0.5 ${surface.muted}`}>
            {route.distanceKm.toFixed(1)} ק&quot;מ • +{Math.round(route.ascentMeters)} מ&apos;
          </div>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={`text-xs font-medium ${surface.muted}`}>
                תיקיית יעד במאגר
              </label>
              <button
                type="button"
                onClick={() => setIsCreatingFolder((v) => !v)}
                className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-500 hover:underline"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                תיקייה חדשה
              </button>
            </div>
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className={`w-full px-3 py-2 rounded-xl border text-xs ${surface.fieldBox}`}
            >
              <option value="">(לא ממוין / ללא תיקייה)</option>
              {folderOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>

            {isCreatingFolder && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="שם תיקייה חדשה..."
                  className={`flex-1 px-3 py-1.5 rounded-xl border text-xs ${surface.fieldBox}`}
                />
                <button
                  type="button"
                  onClick={handleInlineCreateFolder}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950"
                >
                  צור
                </button>
              </div>
            )}
          </div>

          <div>
            <label className={`block text-xs font-medium mb-1 ${surface.muted}`}>
              קטגוריה
            </label>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value as TrailCategoryId)}
              className={`w-full px-3 py-2 rounded-xl border text-xs ${surface.fieldBox}`}
            >
              {TRAIL_CATEGORY_ORDER.map((cid) => {
                const c = TRAIL_CATEGORY_META[cid];
                return (
                  <option key={cid} value={cid}>
                    {c.emoji} {c.labelHe}
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label className={`block text-xs font-medium mb-1.5 ${surface.muted}`}>
              רמת קושי
            </label>
            <div className="grid grid-cols-4 gap-1.5">
              {TRAIL_DIFFICULTY_ORDER.map((did) => {
                const d = TRAIL_DIFFICULTY_META[did];
                const active = difficulty === did;
                return (
                  <button
                    key={did}
                    type="button"
                    onClick={() => setDifficulty(did)}
                    className={`py-2 px-1 rounded-xl text-xs font-bold border transition ${
                      active
                        ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                        : surface.chipIdle
                    }`}
                  >
                    {d.labelHe}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className={`block text-xs font-medium mb-1 ${surface.muted}`}>
              תגיות (מופרדות בפסיק)
            </label>
            <input
              type="text"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="מעלה, מעיין, תצפית"
              className={`w-full px-3 py-2 rounded-xl border text-xs ${surface.fieldBox}`}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className={`px-4 py-2 rounded-xl text-xs font-semibold border ${surface.pillBtn}`}
          >
            ביטול
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-4 py-2 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {isSubmitting ? 'שומר...' : 'שמור במאגר תכנון'}
          </button>
        </div>
      </form>
    </div>
  );
};
