import React from 'react';
import { X } from 'lucide-react';
import { MinimizeToggle } from './MinimizeToggle';
import { getSurfaceTheme, type MapTheme } from './themeTokens';

interface SheetChromeHeaderProps {
  title: string;
  minimized: boolean;
  onToggleMinimize: () => void;
  onClose: () => void;
  theme: MapTheme;
  /** Optional mobile grab/height handle tap handler. */
  onToggleHandle?: () => void;
  /** Shows a centered pill handle in mobile bottom sheets without overlapping buttons. */
  showHandlePill?: boolean;
}

/**
 * Unified top header bar shared across mobile bottom sheets and desktop floating drawers.
 * Keeps minimize (-) and close (X) cleanly aligned in-flow so they never overlap menu content.
 */
export const SheetChromeHeader: React.FC<SheetChromeHeaderProps> = ({
  title,
  minimized,
  onToggleMinimize,
  onClose,
  theme,
  onToggleHandle,
  showHandlePill = false,
}) => {
  const t = getSurfaceTheme(theme);
  return (
    <div
      dir="rtl"
      className={`relative flex items-center justify-between gap-2 px-3 py-1.5 min-h-[2.5rem] shrink-0 ${
        minimized ? '' : 'border-b border-current/10'
      }`}
    >
      <span
        className={`text-xs font-bold truncate ${
          showHandlePill ? 'max-w-[calc(50%-2.5rem)]' : 'min-w-0'
        } ${t.muted}`}
      >
        {title}
      </span>

      {showHandlePill && (
        <button
          type="button"
          onClick={onToggleHandle}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-3 py-2 flex items-center justify-center rounded-full cursor-pointer"
          title={minimized ? 'הרחב חלון' : 'שנה גובה חלונית'}
          aria-label={minimized ? 'הרחב חלון' : 'שינוי גובה חלונית'}
        >
          <span className="block w-10 h-1 rounded-full bg-slate-400/60" />
        </button>
      )}

      <div className="flex items-center gap-1.5 shrink-0">
        <MinimizeToggle
          minimized={minimized}
          onToggle={onToggleMinimize}
          theme={theme}
        />
        <button
          type="button"
          onClick={onClose}
          className={`p-1.5 rounded-lg border transition-colors ${t.pillBtn}`}
          title="סגור"
          aria-label="סגור"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
