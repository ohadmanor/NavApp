import React, { useEffect, useMemo, useState } from 'react';
import {
  Folder,
  FolderPlus,
  FolderTree,
  Search,
  Star,
  Send,
  Trash2,
  Pencil,
  ChevronLeft,
  ChevronDown,
  X,
  ArrowRight,
  SlidersHorizontal,
} from 'lucide-react';
import type {
  PlanningFolderRecord,
  PlanningTrailRecord,
} from '../../core/db/NavDatabase';
import {
  PlanningTrailManager,
  type PlanningFolderTreeNode,
} from '../../core/navigation/PlanningTrailManager';
import {
  TRAIL_CATEGORY_META,
  TRAIL_CATEGORY_ORDER,
  TRAIL_DIFFICULTY_META,
  TRAIL_DIFFICULTY_ORDER,
  type TrailCategoryId,
  type TrailDifficulty,
} from '../../core/navigation/PlanningTrailTaxonomy';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

type VirtualFolderId = 'v-all' | 'v-starred' | 'v-unfiled';
type SortKey = 'updated' | 'name' | 'distance' | 'ascent' | 'difficulty';

interface PlanningTrailDbDrawerProps {
  theme: MapTheme;
  isMobile?: boolean;
  folders: PlanningFolderRecord[];
  trails: PlanningTrailRecord[];
  selectedTrailId: string | null;
  showFolderOnMap?: boolean;
  onSelectTrail: (trailId: string) => void;
  onToggleShowFolderOnMap?: (visibleTrailIds: string[]) => void;
  onCreateFolder: (params: {
    name: string;
    parentId: string | null;
  }) => Promise<PlanningFolderRecord | undefined>;
  onRenameFolder: (folderId: string, newName: string) => Promise<void>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onUpdateTrailMetadata: (
    trailId: string,
    patch: Partial<
      Pick<
        PlanningTrailRecord,
        'name' | 'folderId' | 'categoryId' | 'difficulty' | 'isStarred' | 'tags' | 'notes'
      >
    >
  ) => Promise<void>;
  onEditTrailOnMap?: (trailId: string) => void;
  onDeleteTrail: (trailId: string) => Promise<void>;
  onSendTrailToActiveRoutes: (trailId: string) => Promise<void>;
  onClose?: () => void;
}

export const PlanningTrailDbDrawer: React.FC<PlanningTrailDbDrawerProps> = ({
  theme,
  isMobile = false,
  folders,
  trails,
  selectedTrailId,
  showFolderOnMap,
  onSelectTrail,
  onToggleShowFolderOnMap,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onUpdateTrailMetadata,
  onEditTrailOnMap,
  onDeleteTrail,
  onSendTrailToActiveRoutes,
  onClose,
}) => {
  const surface = getSurfaceTheme(theme);
  const [activeFolderId, setActiveFolderId] = useState<string>('v-all');
  const [categoryFilter, setCategoryFilter] = useState<TrailCategoryId | 'all'>('all');
  const [difficultyFilter, setDifficultyFilter] = useState<TrailDifficulty | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('updated');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setExpandedFolders((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const f of folders) {
        if (f.parentId === null && next[f.id] === undefined) {
          next[f.id] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [folders]);

  // Modals / Inline editors
  const [showNewFolderForm, setShowNewFolderForm] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentId, setNewFolderParentId] = useState<string>('');
  const [editingTrail, setEditingTrail] = useState<PlanningTrailRecord | null>(null);
  const [editName, setEditName] = useState<string>('');
  const [editFolderId, setEditFolderId] = useState<string>('');
  const [editCategoryId, setEditCategoryId] = useState<TrailCategoryId>('4x4');
  const [editDifficulty, setEditDifficulty] = useState<TrailDifficulty>('medium');
  const [editTagsText, setEditTagsText] = useState<string>('');
  const [editNotes, setEditNotes] = useState<string>('');

  const folderTree = useMemo(
    () => PlanningTrailManager.buildFolderTree(folders, trails),
    [folders, trails]
  );

  const breadcrumbs = useMemo(() => {
    if (activeFolderId.startsWith('v-')) return [];
    return PlanningTrailManager.getFolderBreadcrumbs(activeFolderId, folders);
  }, [activeFolderId, folders]);

  const filteredTrails = useMemo(() => {
    let list = trails.slice();

    if (activeFolderId === 'v-starred') {
      list = list.filter((t) => t.isStarred);
    } else if (activeFolderId === 'v-unfiled') {
      list = list.filter((t) => !t.folderId);
    } else if (activeFolderId !== 'v-all') {
      const ids = PlanningTrailManager.getDescendantFolderIds(activeFolderId, folders);
      list = list.filter((t) => t.folderId && ids.has(t.folderId));
    }

    if (categoryFilter !== 'all') {
      list = list.filter((t) => t.categoryId === categoryFilter);
    }
    if (difficultyFilter !== 'all') {
      list = list.filter((t) => t.difficulty === difficultyFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.tags || []).some((tag) => tag.toLowerCase().includes(q)) ||
          (t.notes || '').toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name, 'he');
      if (sortBy === 'distance') return (b.distanceKm || 0) - (a.distanceKm || 0);
      if (sortBy === 'ascent') return (b.ascentMeters || 0) - (a.ascentMeters || 0);
      if (sortBy === 'difficulty') {
        return (
          (TRAIL_DIFFICULTY_META[b.difficulty]?.order || 0) -
          (TRAIL_DIFFICULTY_META[a.difficulty]?.order || 0)
        );
      }
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });

    return list;
  }, [
    trails,
    folders,
    activeFolderId,
    categoryFilter,
    difficultyFilter,
    searchQuery,
    sortBy,
  ]);

  const folderById = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders]
  );

  const childFoldersForMobile = useMemo(() => {
    if (activeFolderId === 'v-starred' || activeFolderId === 'v-unfiled') return [];
    const parentId = activeFolderId === 'v-all' ? null : activeFolderId;
    return folders
      .filter((f) => (f.parentId ?? null) === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'he'));
  }, [folders, activeFolderId]);

  const handleOpenNewFolder = () => {
    setNewFolderParentId(activeFolderId.startsWith('v-') ? '' : activeFolderId);
    setNewFolderName('');
    setShowNewFolderForm(true);
  };

  const handleSubmitNewFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    const created = await onCreateFolder({
      name: newFolderName.trim(),
      parentId: newFolderParentId || null,
    });
    if (created) {
      if (created.parentId) {
        setExpandedFolders((prev) => ({ ...prev, [created.parentId!]: true }));
      }
      setActiveFolderId(created.id);
      setShowNewFolderForm(false);
      setNewFolderName('');
    }
  };

  const openEditTrailModal = (trail: PlanningTrailRecord) => {
    setEditingTrail(trail);
    setEditName(trail.name);
    setEditFolderId(trail.folderId || '');
    setEditCategoryId(trail.categoryId);
    setEditDifficulty(trail.difficulty || 'medium');
    setEditTagsText((trail.tags || []).join(', '));
    setEditNotes(trail.notes || '');
  };

  const handleSaveTrailEdits = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTrail) return;
    const parsedTags = editTagsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await onUpdateTrailMetadata(editingTrail.id, {
      name: editName.trim() || editingTrail.name,
      folderId: editFolderId || null,
      categoryId: editCategoryId,
      difficulty: editDifficulty,
      tags: parsedTags,
      notes: editNotes.trim(),
    });
    setEditingTrail(null);
  };

  const renderTreeNodes = (nodes: PlanningFolderTreeNode[], depth = 0) =>
    nodes.map((node) => {
      const f = node.folder;
      const isExpanded = !!expandedFolders[f.id];
      const isActive = activeFolderId === f.id;
      const hasChildren = node.children.length > 0;

      return (
        <div key={f.id}>
          <div
            style={{ paddingRight: `${depth * 14 + 6}px` }}
            onClick={() => {
              setActiveFolderId(f.id);
              setExpandedFolders((prev) => ({ ...prev, [f.id]: true }));
            }}
            className={`group flex items-center justify-between gap-1 py-1.5 pl-2 rounded-lg text-xs cursor-pointer transition ${
              isActive
                ? 'bg-emerald-500/20 text-emerald-500 border border-emerald-500/40 font-semibold'
                : surface.hoverRow
            }`}
          >
            <div className="flex items-center gap-1 min-w-0">
              {hasChildren ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedFolders((prev) => ({ ...prev, [f.id]: !isExpanded }));
                  }}
                  className="p-0.5 opacity-70 hover:opacity-100"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronLeft className="w-3.5 h-3.5" />
                  )}
                </button>
              ) : (
                <span className="w-4 inline-block" />
              )}
              <Folder className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
              <span className="truncate">{f.name}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <span className={`text-[10px] tabular-nums ${surface.muted}`}>
                {node.recursiveCount}
              </span>
              {isActive && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const nextName = window.prompt('שם חדש לתיקייה:', f.name);
                    if (nextName && nextName.trim()) {
                      void onRenameFolder(f.id, nextName.trim());
                    }
                  }}
                  title="שנה שם תיקייה"
                  className="opacity-70 hover:opacity-100 p-0.5"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}
              {isActive && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      window.confirm(
                        `למחוק את התיקייה "${f.name}"? המסלולים שבה יועברו ל"לא ממוין".`
                      )
                    ) {
                      void onDeleteFolder(f.id);
                      setActiveFolderId(f.parentId || 'v-all');
                    }
                  }}
                  title="מחק תיקייה"
                  className="opacity-70 hover:text-red-500 p-0.5"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
          {hasChildren && isExpanded && renderTreeNodes(node.children, depth + 1)}
        </div>
      );
    });

  const renderTrailCard = (trail: PlanningTrailRecord) => {
    const isSelected = selectedTrailId === trail.id;
    const cat = TRAIL_CATEGORY_META[trail.categoryId] || TRAIL_CATEGORY_META['4x4'];
    const diff = TRAIL_DIFFICULTY_META[trail.difficulty] || TRAIL_DIFFICULTY_META.medium;
    const folder = trail.folderId ? folderById.get(trail.folderId) : undefined;

    return (
      <div
        key={trail.id}
        onClick={() => onSelectTrail(trail.id)}
        className={`rounded-xl border p-2.5 cursor-pointer transition space-y-2 ${
          isSelected
            ? 'border-emerald-500 bg-emerald-500/10'
            : `${surface.subCard} ${surface.hoverRow}`
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
                style={{ backgroundColor: `${cat.color}22`, color: cat.color }}
              >
                {cat.emoji} {cat.labelHe}
              </span>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${diff.badgeClass}`}
              >
                {diff.labelHe}
              </span>
              {folder && (
                <span className={`text-[10px] truncate ${surface.muted}`}>
                  📁 {folder.name}
                </span>
              )}
            </div>
            <div className="text-xs font-bold truncate">{trail.name}</div>
          </div>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void onUpdateTrailMetadata(trail.id, { isStarred: !trail.isStarred });
            }}
            className={`p-1 rounded-lg ${
              trail.isStarred ? 'text-amber-400' : `${surface.muted} hover:text-amber-400`
            }`}
            aria-label="מועדף"
          >
            <Star className={`w-4 h-4 ${trail.isStarred ? 'fill-current' : ''}`} />
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums">
          <div className={`flex items-center gap-2.5 ${surface.muted}`}>
            <span>{trail.distanceKm.toFixed(1)} ק&quot;מ</span>
            <span>+{Math.round(trail.ascentMeters)} מ&apos;</span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openEditTrailModal(trail);
              }}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] ${surface.pillBtn}`}
            >
              <Pencil className="w-3 h-3" />
              ערוך
            </button>
            {onEditTrailOnMap && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditTrailOnMap(trail.id);
                }}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] ${surface.pillBtn}`}
                title="ערוך או צייר את תוואי המסלול על המפה"
              >
                תוואי במפה
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void onSendTrailToActiveRoutes(trail.id);
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-500 text-slate-950 hover:bg-emerald-400"
            >
              <Send className="w-3 h-3" />
              שלח למסלולים
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`למחוק את "${trail.name}" ממאגר התכנון?`)) {
                  void onDeleteTrail(trail.id);
                }
              }}
              className={`p-1 rounded-lg hover:text-red-500 ${surface.muted}`}
              aria-label="מחק מסלול"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const breadcrumbLabel =
    activeFolderId === 'v-all'
      ? 'כל המסלולים במאגר'
      : activeFolderId === 'v-starred'
        ? 'מועדפים'
        : activeFolderId === 'v-unfiled'
          ? 'לא ממוין'
          : breadcrumbs.map((b) => b.name).join(' ◂ ');

  const virtualFolders: Array<{ id: VirtualFolderId; label: string; count: number }> = [
    { id: 'v-all', label: 'כל המסלולים', count: trails.length },
    { id: 'v-starred', label: 'מועדפים ⭐', count: trails.filter((t) => t.isStarred).length },
    { id: 'v-unfiled', label: 'לא ממוין', count: trails.filter((t) => !t.folderId).length },
  ];

  return (
    <div className={`flex flex-col flex-1 min-h-0 overflow-hidden gap-3 ${isMobile ? 'p-3' : 'p-3.5'}`} dir="rtl">
      {/* Header */}
      <div className={`flex flex-wrap items-center justify-between gap-2 pb-2 border-b shrink-0 ${surface.divider}`}>
        <div className="flex items-center gap-2">
          <FolderTree className="w-5 h-5 text-emerald-500" />
          <div>
            <h2 className="text-sm font-bold">מאגר תכנון מסלולים</h2>
            <p className={`text-[11px] ${surface.muted}`}>
              {trails.length} מסלולים • {folders.length} תיקיות
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleOpenNewFolder}
            title="תיקייה חדשה"
            aria-label="תיקייה חדשה"
            className="p-2 rounded-xl bg-emerald-500/15 text-emerald-500 border border-emerald-500/30 hover:bg-emerald-500/25 transition"
          >
            <FolderPlus className="w-4 h-4" />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className={`p-1.5 rounded-xl border ${surface.pillBtn}`}
              aria-label="סגור"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Inline New Folder Form */}
      {showNewFolderForm && (
        <form
          onSubmit={handleSubmitNewFolder}
          className={`rounded-xl border p-2.5 flex flex-wrap items-center gap-2 ${surface.subCard}`}
        >
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="שם תיקייה חדשה..."
            className={`flex-1 min-w-[140px] px-3 py-1.5 rounded-xl border text-xs ${surface.fieldBox}`}
          />
          <select
            value={newFolderParentId}
            onChange={(e) => setNewFolderParentId(e.target.value)}
            className={`px-2.5 py-1.5 rounded-xl border text-xs ${surface.fieldBox}`}
          >
            <option value="">תיקייה ראשית</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                תחת: {f.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950"
          >
            צור
          </button>
          <button
            type="button"
            onClick={() => setShowNewFolderForm(false)}
            className={`px-2.5 py-1.5 rounded-xl text-xs border ${surface.pillBtn}`}
          >
            ביטול
          </button>
        </form>
      )}

      {/* Main Content: Desktop Two-Pane vs Mobile Drill-down */}
      <div className={`flex-1 min-h-0 overflow-hidden ${isMobile ? 'flex flex-col gap-2.5' : 'grid grid-cols-[minmax(200px,48%)_1fr] gap-3'}`}>
        {!isMobile && (
          <aside className={`h-full min-h-0 rounded-xl border p-2.5 overflow-y-auto space-y-2 ${surface.subCard}`}>
            <div className={`text-[10px] font-bold uppercase px-1 ${surface.muted}`}>
              תצוגות מהירות
            </div>
            <div className="space-y-0.5">
              {virtualFolders.map((vf) => (
                <div
                  key={vf.id}
                  onClick={() => setActiveFolderId(vf.id)}
                  className={`flex items-center justify-between px-2 py-1.5 rounded-lg text-xs cursor-pointer transition ${
                    activeFolderId === vf.id
                      ? 'bg-emerald-500/20 text-emerald-500 border border-emerald-500/40 font-semibold'
                      : surface.hoverRow
                  }`}
                >
                  <span>{vf.label}</span>
                  <span className={`text-[10px] tabular-nums ${surface.muted}`}>{vf.count}</span>
                </div>
              ))}
            </div>
            <div className={`border-t pt-2 ${surface.divider}`}>
              <div className={`text-[10px] font-bold uppercase px-1 mb-1 ${surface.muted}`}>
                תיקיות ותתי-תיקיות
              </div>
              {folderTree.length > 0 ? (
                renderTreeNodes(folderTree, 0)
              ) : (
                <div className={`text-[11px] px-2 py-3 ${surface.muted}`}>
                  אין תיקיות עדיין. צרו תיקייה ראשונה למעלה.
                </div>
              )}
            </div>
          </aside>
        )}

        <div className="flex-1 flex flex-col gap-2 min-w-0 min-h-0 overflow-hidden">
          {/* Breadcrumbs + Mobile Back + Subfolders toggle */}
          <div className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl border text-xs shrink-0 ${surface.subCard}`}>
            <div className="flex items-center gap-1.5 min-w-0">
              {isMobile && !activeFolderId.startsWith('v-') && (
                <button
                  type="button"
                  onClick={() => {
                    const cur = folderById.get(activeFolderId);
                    setActiveFolderId(cur?.parentId || 'v-all');
                  }}
                  className={`p-1 rounded-lg border ${surface.pillBtn}`}
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
              <span className="font-semibold truncate">📁 {breadcrumbLabel}</span>
            </div>
          </div>

          {/* Mobile Child Folders Drill-Down */}
          {isMobile && childFoldersForMobile.length > 0 && (
            <div className="grid grid-cols-2 gap-1.5">
              {childFoldersForMobile.map((cf) => (
                <button
                  key={cf.id}
                  type="button"
                  onClick={() => setActiveFolderId(cf.id)}
                  className={`flex items-center justify-between px-2.5 py-2 rounded-xl border text-xs font-semibold ${surface.subCard}`}
                >
                  <span className="truncate">📁 {cf.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Search + Category + Difficulty + Sort */}
          <div className="flex flex-wrap gap-1.5 shrink-0">
            <div className="relative flex-1 min-w-[130px]">
              <Search className={`w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 ${surface.muted}`} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="חיפוש מסלול או תגית..."
                className={`w-full pr-8 pl-2.5 py-1.5 rounded-xl border text-xs ${surface.fieldBox}`}
              />
            </div>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as TrailCategoryId | 'all')}
              className={`px-2 py-1.5 rounded-xl border text-xs ${surface.fieldBox}`}
              aria-label="סינון לפי סוג מסלול"
            >
              <option value="all">סוג: הכל</option>
              {TRAIL_CATEGORY_ORDER.map((cid) => {
                const cat = TRAIL_CATEGORY_META[cid];
                return (
                  <option key={cid} value={cid}>
                    {cat.emoji} {cat.labelHe}
                  </option>
                );
              })}
            </select>

            <select
              value={difficultyFilter}
              onChange={(e) => setDifficultyFilter(e.target.value as TrailDifficulty | 'all')}
              className={`px-2 py-1.5 rounded-xl border text-xs ${surface.fieldBox}`}
            >
              <option value="all">קושי: הכל</option>
              {TRAIL_DIFFICULTY_ORDER.map((did) => (
                <option key={did} value={did}>
                  {TRAIL_DIFFICULTY_META[did].labelHe} ({TRAIL_DIFFICULTY_META[did].labelEn})
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1">
              <SlidersHorizontal className={`w-3.5 h-3.5 ${surface.muted}`} />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
                className={`px-2 py-1.5 rounded-xl border text-xs ${surface.fieldBox}`}
              >
                <option value="updated">עודכן לאחרונה</option>
                <option value="name">שם</option>
                <option value="distance">מרחק</option>
                <option value="ascent">טיפוס</option>
                <option value="difficulty">רמת קושי</option>
              </select>
            </div>
          </div>

          {/* Trail List */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5">
            {filteredTrails.length > 0 ? (
              filteredTrails.map(renderTrailCard)
            ) : (
              <div className={`text-center py-10 text-xs ${surface.muted}`}>
                אין מסלולים התואמים לסינון הנוכחי. ניתן לשלוח מסלולים מהתפריט &quot;מסלולים&quot; למאגר זה.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit Trail Modal */}
      {editingTrail && (
        <div className="fixed inset-0 z-[130] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveTrailEdits}
            className={`w-full max-w-md rounded-2xl border p-4 space-y-3 max-h-[85vh] overflow-y-auto ${surface.panelSolid}`}
          >
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold truncate">עריכת מסלול</h4>
              <button type="button" onClick={() => setEditingTrail(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className={`block text-xs mb-1 ${surface.muted}`}>שם המסלול</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
                className={`w-full px-3 py-2 rounded-xl border text-xs ${surface.fieldBox}`}
              />
            </div>
            <div>
              <label className={`block text-xs mb-1 ${surface.muted}`}>תיקייה</label>
              <select
                value={editFolderId}
                onChange={(e) => setEditFolderId(e.target.value)}
                className={`w-full px-3 py-2 rounded-xl border text-xs ${surface.fieldBox}`}
              >
                <option value="">(לא ממוין)</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={`block text-xs mb-1 ${surface.muted}`}>קטגוריה</label>
              <select
                value={editCategoryId}
                onChange={(e) => setEditCategoryId(e.target.value as TrailCategoryId)}
                className={`w-full px-3 py-2 rounded-xl border text-xs ${surface.fieldBox}`}
              >
                {TRAIL_CATEGORY_ORDER.map((cid) => (
                  <option key={cid} value={cid}>
                    {TRAIL_CATEGORY_META[cid].emoji} {TRAIL_CATEGORY_META[cid].labelHe}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={`block text-xs mb-1 ${surface.muted}`}>רמת קושי</label>
              <div className="grid grid-cols-4 gap-1.5">
                {TRAIL_DIFFICULTY_ORDER.map((did) => (
                  <button
                    key={did}
                    type="button"
                    onClick={() => setEditDifficulty(did)}
                    className={`py-1.5 rounded-xl text-xs font-bold border ${
                      editDifficulty === did
                        ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                        : surface.chipIdle
                    }`}
                  >
                    {TRAIL_DIFFICULTY_META[did].labelHe}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={`block text-xs mb-1 ${surface.muted}`}>תגיות (מופרדות בפסיק)</label>
              <input
                type="text"
                value={editTagsText}
                onChange={(e) => setEditTagsText(e.target.value)}
                placeholder="צופים, מפה 1, אדום..."
                className={`w-full px-3 py-2 rounded-xl border text-xs ${surface.fieldBox}`}
              />
            </div>
            <div>
              <label className={`block text-xs mb-1 ${surface.muted}`}>הערות ופרטי מסלול</label>
              <textarea
                rows={4}
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                className={`w-full px-3 py-2 rounded-xl border text-xs ${surface.fieldBox}`}
              />
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              {onEditTrailOnMap ? (
                <button
                  type="button"
                  onClick={() => {
                    const id = editingTrail.id;
                    setEditingTrail(null);
                    onEditTrailOnMap(id);
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${surface.pillBtn}`}
                >
                  ערוך / צייר תוואי במפה
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditingTrail(null)}
                  className={`px-3 py-1.5 rounded-xl text-xs border ${surface.pillBtn}`}
                >
                  ביטול
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950"
                >
                  שמור
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
