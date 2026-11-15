import React from 'react';
import { ChevronUp, Minus } from 'lucide-react';
import { getSurfaceTheme, type MapTheme } from './themeTokens';

interface MinimizeToggleProps {
  minimized: boolean;
  onToggle: () => void;
  theme: MapTheme;
  className?: string;
}

/** Small header button that minimizes a floating window to its title bar and restores it. */
export const MinimizeToggle: React.FC<MinimizeToggleProps> = ({
  minimized,
  onToggle,
  theme,
  className = '',
}) => {
  const t = getSurfaceTheme(theme);
  const label = minimized ? 'הרחב חלון' : 'מזער חלון';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`p-1.5 rounded-lg border transition-colors ${t.pillBtn} ${className}`}
      title={label}
      aria-label={label}
      aria-expanded={!minimized}
    >
      {minimized ? <ChevronUp className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
    </button>
  );
};
