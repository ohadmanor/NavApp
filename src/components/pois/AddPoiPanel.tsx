import React, { useState } from 'react';
import { X, Crosshair, Check } from 'lucide-react';
import type { PoiCategory, PoiRecord } from '../../core/db/NavDatabase';
import { PoiManager } from '../../core/pois/PoiManager';
import {
  POI_CATEGORIES,
  POI_CATEGORY_SPECS,
  POI_SYMBOLS_BY_CATEGORY,
} from '../../core/pois/poiTaxonomy';
import { ElevationService } from '../../core/navigation/ElevationService';
import { MilitaryGridService } from '../../core/navigation/MilitaryGridService';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';
import { PoiCategoryIcon } from './PoiCategoryIcon';

interface AddPoiPanelProps {
  theme: MapTheme;
  centerCoords: { lon: number; lat: number; ele: number | null };
  onClose: () => void;
  onCreated: (poi: PoiRecord) => void;
}

export const AddPoiPanel: React.FC<AddPoiPanelProps> = ({
  theme,
  centerCoords,
  onClose,
  onCreated,
}) => {
  const [category, setCategory] = useState<PoiCategory>('water');
  const [subcategory, setSubcategory] = useState<string>(POI_CATEGORY_SPECS.water.defaultSubcategory);
  const [nameHe, setNameHe] = useState('');
  const [descHe, setDescHe] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const t = getSurfaceTheme(theme);
  const milCoords = MilitaryGridService.toMilitaryCoords(centerCoords.lon, centerCoords.lat);
  const categorySymbols = POI_SYMBOLS_BY_CATEGORY[category] || [];

  const handleSelectCategory = (nextCat: PoiCategory) => {
    setCategory(nextCat);
    setSubcategory(POI_CATEGORY_SPECS[nextCat].defaultSubcategory);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameHe.trim() || isSaving) return;
    setIsSaving(true);
    try {
      const ele =
        centerCoords.ele ??
        (await ElevationService.getElevationAt(centerCoords.lon, centerCoords.lat, 12));
      const created = await PoiManager.addCustomUserPoi({
        nameHe: nameHe.trim(),
        category,
        subcategory,
        lon: centerCoords.lon,
        lat: centerCoords.lat,
        ele,
        descHe: descHe.trim() || 'נקודת עניין שדווחה בשטח',
      });
      onCreated(created);
    } finally {
      setIsSaving(false);
    }
  };

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

      <button
        type="submit"
        disabled={isSaving || !nameHe.trim()}
        className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-colors"
      >
        <Check className="w-4 h-4" />
        <span>{isSaving ? 'שומר...' : 'שמור נקודה במפה'}</span>
      </button>
    </form>
  );
};
