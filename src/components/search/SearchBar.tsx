import React, { useEffect, useRef, useState } from 'react';
import { Search, Route as RouteIcon, X } from 'lucide-react';
import type { SearchIndexStatus, SearchResultItem } from '../../core/search/PMTilesSearchService';
import { SEARCH_FILTER_TABS, type SearchFilterCategory } from '../../core/search/searchTaxonomy';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';
import { PoiCategoryIcon } from '../pois/PoiCategoryIcon';

const QUICK_EXAMPLES = [
  'ירושלים',
  'עין עקב',
  'כביש 6',
  'הר מירון',
  'נחל צין',
  'מעלה זיק',
  '1813-5828',
];

export interface SearchBarProps {
  compactMobile: boolean;
  theme: MapTheme;
  containerRef: React.RefObject<HTMLDivElement | null>;
  searchQuery: string;
  onChangeSearchQuery: (query: string) => void;
  searchFilter: SearchFilterCategory;
  onChangeSearchFilter: (filter: SearchFilterCategory) => void;
  searchResults: SearchResultItem[];
  isSearching: boolean;
  searchStatus: SearchIndexStatus;
  activeSearchIndex: number;
  onChangeActiveSearchIndex: React.Dispatch<React.SetStateAction<number>>;
  isSearchFocused: boolean;
  onChangeSearchFocused: (focused: boolean) => void;
  onClearSearch: () => void;
  onSelectResult: (item: SearchResultItem) => void;
  onRebuildIndex: () => void;
  hasOsmInfo: boolean;
  isOfflineReady: boolean;
  isOnline: boolean;
  onOpenMobileOffline: () => void;
  onToggleDesktopRoutes: () => void;
}

export const SearchBar: React.FC<SearchBarProps> = React.memo(
  ({
    compactMobile,
    theme,
    containerRef,
    searchQuery,
    onChangeSearchQuery,
    searchFilter,
    onChangeSearchFilter,
    searchResults,
    isSearching,
    searchStatus,
    activeSearchIndex,
    onChangeActiveSearchIndex,
    isSearchFocused,
    onChangeSearchFocused,
    onClearSearch,
    onSelectResult,
    onRebuildIndex,
    hasOsmInfo,
    isOfflineReady,
    isOnline,
    onOpenMobileOffline,
    onToggleDesktopRoutes,
  }) => {
    const t = getSurfaceTheme(theme);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const isComposingRef = useRef(false);
    const lastSyncedPropRef = useRef(searchQuery);
    const [localQuery, setLocalQuery] = useState(searchQuery);

    // Sync external resets/quick-example selections into the input only when not actively composing IME text
    useEffect(() => {
      if (searchQuery !== lastSyncedPropRef.current) {
        lastSyncedPropRef.current = searchQuery;
        if (searchQuery === '') {
          isComposingRef.current = false;
          setLocalQuery('');
        } else if (!isComposingRef.current) {
          setLocalQuery(searchQuery);
        }
      }
    }, [searchQuery]);

    const effectiveQuery = localQuery;
    const showDropdown = isSearchFocused || effectiveQuery.trim().length > 0;
    const isIndexingCustom = Boolean(searchStatus.indexingProgress);
    const indexPct =
      searchStatus.indexingProgress && searchStatus.indexingProgress.total > 0
        ? Math.min(
            100,
            Math.round(
              (searchStatus.indexingProgress.done / searchStatus.indexingProgress.total) * 100
            )
          )
        : 0;

    const commitInputText = (nextVal: string) => {
      lastSyncedPropRef.current = nextVal;
      setLocalQuery(nextVal);
      onChangeSearchQuery(nextVal);
      onChangeSearchFocused(true);
    };

    return (
      <div ref={containerRef} className="relative">
        <div
          className={`flex items-center gap-2 border transition-colors ${
            compactMobile ? 'rounded-full px-3.5 py-2' : 'rounded-2xl px-3.5 py-2.5'
          } ${t.panel}`}
        >
          <Search
            className={`w-4 h-4 shrink-0 ${
              isIndexingCustom ? 'text-amber-500 animate-pulse' : 'text-emerald-500'
            }`}
          />
          <input
            id={compactMobile ? 'map-search-input-mobile' : 'map-search-input-desktop'}
            name="mapSearch"
            ref={inputRef}
            type="text"
            dir="auto"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={localQuery}
            onFocus={() => onChangeSearchFocused(true)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              // Ignore trailing compositionend emitted while blurring after result selection/reset
              if (document.activeElement !== e.currentTarget && lastSyncedPropRef.current === '') {
                return;
              }
              commitInputText(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              const composing = isComposingRef.current || e.nativeEvent.isComposing;
              if (composing) return;

              if (e.key === 'Escape') {
                onChangeSearchFocused(false);
                e.currentTarget.blur();
                return;
              }
              if (e.key === 'ArrowDown' && searchResults.length > 0) {
                e.preventDefault();
                onChangeActiveSearchIndex((idx) => (idx + 1) % searchResults.length);
                return;
              }
              if (e.key === 'ArrowUp' && searchResults.length > 0) {
                e.preventDefault();
                onChangeActiveSearchIndex(
                  (idx) => (idx - 1 + searchResults.length) % searchResults.length
                );
                return;
              }
              if (e.key === 'Enter' && !isSearching && searchResults.length > 0) {
                e.preventDefault();
                const chosen = searchResults[activeSearchIndex] || searchResults[0];
                if (chosen) {
                  isComposingRef.current = false;
                  lastSyncedPropRef.current = '';
                  setLocalQuery('');
                  onSelectResult(chosen);
                  e.currentTarget.blur();
                }
              }
            }}
            onChange={(e) => {
              commitInputText(e.target.value);
            }}
            placeholder="חפש עיר, רחוב, נחל, הר, חניון, נ.צ..."
            className={`w-full bg-transparent text-sm focus:outline-none select-text ${t.input}`}
          />
          {localQuery && (
            <button
              type="button"
              onClick={() => {
                isComposingRef.current = false;
                lastSyncedPropRef.current = '';
                setLocalQuery('');
                onClearSearch();
                inputRef.current?.focus();
              }}
              className={`p-1 rounded-full text-xs font-bold shrink-0 ${t.muted}`}
              title="נקה חיפוש"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {compactMobile ? (
            <button
              type="button"
              onClick={onOpenMobileOffline}
              className={`px-2 py-0.5 rounded-full text-xs font-bold flex items-center gap-1 shrink-0 ${
                isOfflineReady
                  ? 'bg-emerald-500/15 text-emerald-600'
                  : isOnline
                    ? 'bg-sky-500/15 text-sky-600'
                    : 'bg-amber-500/20 text-amber-600'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isOfflineReady ? 'bg-emerald-500' : isOnline ? 'bg-sky-500' : 'bg-amber-500'
                }`}
              />
              <span>{isOfflineReady ? 'אופליין' : isOnline ? 'מקוון' : 'מנותק'}</span>
            </button>
          ) : (
            <>
              <div className="h-5 w-px bg-current opacity-15 shrink-0" />
              <button
                type="button"
                onClick={onToggleDesktopRoutes}
                title="מסלולים ופרופיל גובה"
                className="p-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition-colors shrink-0"
              >
                <RouteIcon className="w-4 h-4" />
              </button>
            </>
          )}
        </div>

        {/* Rich Unified Search Panel */}
        {showDropdown && (
          <div
            className={`absolute top-full left-0 right-0 mt-2 rounded-2xl border overflow-hidden z-50 flex flex-col max-h-[60vh] md:max-h-[460px] ${t.panel}`}
          >
            {/* Category Filter Chips */}
            <div
              className={`px-2.5 py-2 border-b flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0 ${t.divider}`}
            >
              {SEARCH_FILTER_TABS.map((tab) => {
                const active = searchFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => onChangeSearchFilter(tab.id)}
                    className={`px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap flex items-center gap-1 transition-colors shrink-0 ${
                      active
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : `border ${t.pillBtn}`
                    }`}
                  >
                    <span>{tab.emoji}</span>
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Indexing Status Strip when extracting custom PMTiles archive */}
            {isIndexingCustom && (
              <div
                className={`px-3 py-1.5 border-b text-xs flex items-center justify-between gap-2 text-amber-500 font-semibold ${t.divider}`}
              >
                <span>מעדכן אינדקס חיפוש מהמפה החדשה...</span>
                <span className="font-mono">{indexPct}%</span>
              </div>
            )}

            {/* Body: Suggestions (if empty) OR Ranked Results OR Searching OR Empty State */}
            <div className="overflow-y-auto min-h-0 flex-1">
              {searchResults.length > 0 ? (
                searchResults.map((item, idx) => {
                  const isHighlighted = idx === activeSearchIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        isComposingRef.current = false;
                        lastSyncedPropRef.current = '';
                        setLocalQuery('');
                        inputRef.current?.blur();
                        onSelectResult(item);
                      }}
                      onMouseEnter={() => onChangeActiveSearchIndex(idx)}
                      className={`w-full text-right px-3.5 py-2.5 border-b flex items-center justify-between gap-2.5 transition-colors ${t.divider} ${
                        isHighlighted ? 'bg-emerald-500/12' : t.hoverRow
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {item.kind === 'curated-poi' || item.filterGroup === 'nature' || item.filterGroup === 'pois' ? (
                          <PoiCategoryIcon
                            category={item.poiCategory}
                            subcategory={item.subcategory}
                            size={20}
                          />
                        ) : (
                          <span className="text-base shrink-0">{item.emoji}</span>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-xs font-bold truncate" dir="auto">
                              {item.title}
                            </span>
                            {item.ref && item.filterGroup === 'roads' && (
                              <span
                                dir="ltr"
                                className="px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-500/40 text-sky-500 text-[10px] font-mono font-bold shrink-0"
                              >
                                {item.ref}
                              </span>
                            )}
                          </div>
                          <div className={`text-xs truncate ${t.muted}`} dir="auto">
                            {item.subtitle}
                          </div>
                        </div>
                      </div>
                      <div className="text-left shrink-0 space-y-0.5">
                        {item.distanceKm !== null && (
                          <div className="text-xs font-mono font-bold text-emerald-500">
                            {item.distanceKm < 1
                              ? `${Math.round(item.distanceKm * 1000)} מ׳`
                              : `${item.distanceKm.toFixed(1)} ק״מ`}
                          </div>
                        )}
                        <div className={`text-[11px] font-mono ${t.muted}`}>
                          {item.ele !== null ? `${item.ele}m` : item.locality || item.categoryLabel}
                        </div>
                      </div>
                    </button>
                  );
                })
              ) : !effectiveQuery.trim() ? (
                <div className="p-3 space-y-2.5">
                  <div className={`text-xs flex items-center justify-between ${t.muted}`}>
                    <span>
                      {searchStatus.ready
                        ? `מוכנים ${searchStatus.totalFeatures.toLocaleString()} יעדים מהמפה + נ.צ.`
                        : 'טוען אינדקס מפה...'}
                    </span>
                    {hasOsmInfo && (
                      <button
                        type="button"
                        onClick={onRebuildIndex}
                        disabled={isIndexingCustom}
                        className="text-emerald-500 hover:underline disabled:opacity-40 font-semibold"
                        title="סרוק מחדש את כל שכבות ה-PMTiles"
                      >
                        סרוק מחדש
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => {
                          isComposingRef.current = false;
                          onChangeSearchFilter('all');
                          commitInputText(ex);
                        }}
                        className={`px-2.5 py-1 rounded-full border text-xs font-semibold transition-colors ${t.pillBtn}`}
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              ) : isSearching ? (
                <div className={`p-4 text-center text-xs ${t.muted}`}>מחפש במפה...</div>
              ) : (
                <div className={`p-4 text-center text-xs space-y-2 ${t.muted}`}>
                  <div>לא נמצאו תוצאות עבור &ldquo;{effectiveQuery}&rdquo;</div>
                  {searchFilter !== 'all' ? (
                    <button
                      type="button"
                      onClick={() => onChangeSearchFilter('all')}
                      className="px-3 py-1 rounded-full bg-emerald-600 text-white font-bold"
                    >
                      חפש בכל הקטגוריות
                    </button>
                  ) : (
                    <div>נסה שם עיר, רחוב, נחל, הר, כביש 6 או נ.צ. (לדוגמה 31.77, 35.21)</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
);

SearchBar.displayName = 'SearchBar';
