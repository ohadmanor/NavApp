import React, { useEffect, useState } from 'react';
import { X, Search, Globe, Check, Loader2 } from 'lucide-react';
import {
  BUILT_IN_USER_ICONS,
  USER_ICON_ACCENT_COLORS,
  UserLocationIconService,
  type UserIconCategory,
  type UserLocationIconOption,
  type UserLocationIconPreference,
} from '../../core/navigation/UserLocationIconService';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface UserIconPickerSheetProps {
  isOpen: boolean;
  theme: MapTheme;
  preference: UserLocationIconPreference;
  isOnline: boolean;
  embedded?: boolean;
  onSelectPreference: (next: UserLocationIconPreference) => void;
  onClose: () => void;
}

const IconSvgBadge: React.FC<{
  icon: UserLocationIconOption;
  accentColor: string;
  size?: 'sm' | 'md' | 'lg';
}> = ({ icon, accentColor, size = 'md' }) => {
  const [svgHtml, setSvgHtml] = useState<string | null>(() => icon.inlineSvg || null);

  useEffect(() => {
    let cancelled = false;
    if (icon.id === 'gps-puck') {
      setSvgHtml(null);
      return;
    }
    if (icon.inlineSvg) {
      setSvgHtml(icon.inlineSvg);
      return;
    }
    void UserLocationIconService.loadIconSvgMarkup(icon).then((markup) => {
      if (!cancelled) setSvgHtml(markup);
    });
    return () => {
      cancelled = true;
    };
  }, [icon]);

  const outerClass =
    size === 'lg' ? 'w-11 h-11' : size === 'sm' ? 'w-7 h-7' : 'w-9 h-9';
  const dotClass = size === 'lg' ? 'w-5 h-5' : size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';

  if (icon.id === 'gps-puck') {
    return (
      <span
        className={`${outerClass} rounded-full flex items-center justify-center relative shrink-0`}
        style={{ backgroundColor: `${accentColor}26`, border: `1.5px solid ${accentColor}80` }}
      >
        <span
          className={`${dotClass} rounded-full border-2 border-white shadow`}
          style={{ backgroundColor: accentColor }}
        />
      </span>
    );
  }

  return (
    <span
      className={`${outerClass} rounded-full border-2 border-white shadow-md flex items-center justify-center text-white shrink-0`}
      style={{ backgroundColor: accentColor }}
    >
      {svgHtml ? (
        <span
          className="flex items-center justify-center w-5 h-5"
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      ) : (
        <span className="w-2.5 h-2.5 rounded-full bg-white/80" />
      )}
    </span>
  );
};

export const UserLocationIconBadge = IconSvgBadge;

const CATEGORY_TABS: Array<{ id: 'all' | UserIconCategory; label: string }> = [
  { id: 'all', label: 'הכל' },
  { id: 'vehicles', label: 'רכב ו-4x4' },
  { id: 'outdoor', label: 'טיול וספורט' },
  { id: 'tactical', label: 'טקטי' },
  { id: 'web', label: 'מהרשת' },
];

export const UserIconPickerSheet: React.FC<UserIconPickerSheetProps> = ({
  isOpen,
  theme,
  preference,
  isOnline,
  embedded = false,
  onSelectPreference,
  onClose,
}) => {
  const t = getSurfaceTheme(theme);
  const [category, setCategory] = useState<'all' | UserIconCategory>('all');
  const [customSavedIcons, setCustomSavedIcons] = useState<UserLocationIconOption[]>(() =>
    UserLocationIconService.getCustomWebIcons()
  );
  const [webQuery, setWebQuery] = useState('');
  const [webResults, setWebResults] = useState<UserLocationIconOption[]>([]);
  const [isSearchingWeb, setIsSearchingWeb] = useState(false);
  const [webSearchError, setWebSearchError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleChooseIcon = async (icon: UserLocationIconOption) => {
    setApplyingId(icon.id);
    try {
      const saved = await UserLocationIconService.setPreference({
        icon,
        accentColor: preference.accentColor,
      });
      setCustomSavedIcons(UserLocationIconService.getCustomWebIcons());
      onSelectPreference(saved);
    } finally {
      setApplyingId(null);
    }
  };

  const handleChooseColor = async (hex: string) => {
    const saved = await UserLocationIconService.setPreference({
      icon: preference.icon,
      accentColor: hex,
    });
    onSelectPreference(saved);
  };

  const handleSearchWeb = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = webQuery.trim();
    if (!q) {
      setWebResults([]);
      setWebSearchError(null);
      return;
    }
    if (!isOnline) {
      setWebSearchError('חיפוש אייקונים חדשים דורש חיבור לרשת — האייקונים השמורים זמינים גם אופליין');
      return;
    }
    setIsSearchingWeb(true);
    setWebSearchError(null);
    try {
      const hits = await UserLocationIconService.searchWebIcons(q, 16);
      setWebResults(hits);
      if (hits.length === 0) {
        setWebSearchError('לא נמצאו אייקונים מתאימים — נסה מילה באנגלית (לדוגמה jeep, helicopter, kayak)');
      }
    } catch {
      setWebSearchError('שגיאה בחיפוש אייקונים מהרשת');
    } finally {
      setIsSearchingWeb(false);
    }
  };

  const allLocalIcons: UserLocationIconOption[] = [
    ...BUILT_IN_USER_ICONS,
    ...customSavedIcons.filter((c) => !BUILT_IN_USER_ICONS.some((b) => b.id === c.id)),
  ];

  const displayedIcons =
    webResults.length > 0
      ? webResults
      : category === 'all'
        ? allLocalIcons
        : allLocalIcons.filter((i) => i.category === category);

  const content = (
    <div dir="rtl" className="p-4 space-y-3.5 max-h-[75vh] overflow-y-auto">
      {/* Header + Live Preview */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <IconSvgBadge
            icon={preference.icon}
            accentColor={preference.accentColor}
            size="lg"
          />
          <div>
            <h3 className="text-sm font-bold leading-tight">אייקון המיקום שלי במפה</h3>
            <p className={`text-xs ${t.muted}`}>
              נבחר: <span className="font-semibold">{preference.icon.labelHe}</span>
            </p>
          </div>
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

      {/* Accent Color Picker */}
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs font-semibold ${t.muted}`}>צבע סמן:</span>
        <div className="flex items-center gap-2">
          {USER_ICON_ACCENT_COLORS.map((c) => {
            const selected = preference.accentColor.toLowerCase() === c.hex.toLowerCase();
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => void handleChooseColor(c.hex)}
                title={c.labelHe}
                className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-transform ${
                  selected ? 'scale-115 border-white ring-2 ring-emerald-500' : 'border-white/70 opacity-85 hover:opacity-100'
                }`}
                style={{ backgroundColor: c.hex }}
              >
                {selected && <Check className="w-3.5 h-3.5 text-white stroke-[3]" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Search More Icons from the Web */}
      <form onSubmit={(e) => void handleSearchWeb(e)} className="flex items-center gap-1.5">
        <div className={`flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs ${t.subCard}`}>
          <Globe className="w-3.5 h-3.5 text-sky-500 shrink-0" />
          <input
            type="text"
            dir="auto"
            value={webQuery}
            onChange={(e) => {
              setWebQuery(e.target.value);
              if (!e.target.value.trim()) {
                setWebResults([]);
                setWebSearchError(null);
              }
            }}
            placeholder="חפש אייקון מהרשת (jeep, kayak, helicopter...)"
            className={`w-full bg-transparent focus:outline-none ${t.input}`}
          />
          {webQuery && (
            <button
              type="button"
              onClick={() => {
                setWebQuery('');
                setWebResults([]);
                setWebSearchError(null);
              }}
              className={`text-xs ${t.muted}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <button
          type="submit"
          disabled={isSearchingWeb || !webQuery.trim()}
          className="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1 shrink-0"
        >
          {isSearchingWeb ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Search className="w-3.5 h-3.5" />
          )}
          <span>חפש</span>
        </button>
      </form>

      {webSearchError && (
        <div className="text-xs text-amber-500 font-medium">{webSearchError}</div>
      )}

      {/* Category Filter Tabs (when showing curated/saved icons) */}
      {webResults.length === 0 && (
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {CATEGORY_TABS.map((tab) => {
            const active = category === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setCategory(tab.id)}
                className={`px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${
                  active ? 'bg-emerald-600 text-white' : `border ${t.pillBtn}`
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Icon Grid */}
      {displayedIcons.length > 0 ? (
        <div className="grid grid-cols-4 gap-2">
          {displayedIcons.map((item) => {
            const isSelected = preference.icon.id === item.id;
            const isBusy = applyingId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void handleChooseIcon(item)}
                className={`p-2 rounded-xl border flex flex-col items-center gap-1.5 text-center transition-all ${
                  isSelected
                    ? 'border-emerald-500 bg-emerald-500/15 ring-1 ring-emerald-500'
                    : `${t.subCard} hover:border-sky-400`
                }`}
              >
                <div className="relative">
                  <IconSvgBadge icon={item} accentColor={preference.accentColor} size="md" />
                  {isBusy && (
                    <span className="absolute inset-0 rounded-full bg-slate-950/60 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-white animate-spin" />
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-semibold leading-tight line-clamp-1 w-full" dir="auto">
                  {item.labelHe}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className={`text-xs text-center py-4 ${t.muted}`}>
          אין אייקונים בקטגוריה זו עדיין — חפש אייקון חדש מהרשת למעלה!
        </div>
      )}
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div
      className={`fixed bottom-20 left-16 z-40 w-[340px] max-w-[calc(100vw-5rem)] rounded-2xl border shadow-2xl overflow-hidden ${t.panel}`}
    >
      {content}
    </div>
  );
};
