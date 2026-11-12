import React from 'react';
import type { PoiCategory } from '../../core/db/NavDatabase';
import { resolvePoiSymbolId, type PoiSymbolId } from '../../core/pois/poiTaxonomy';
import { buildPoiSymbolSvgInner } from '../../core/pois/poiSymbolSvg';

export interface PoiCategoryIconProps {
  category: PoiCategory;
  subcategory?: string | null;
  symbolId?: PoiSymbolId;
  size?: 'xs' | 'sm' | 'md' | 'lg' | number;
  className?: string;
  title?: string;
}

const SIZE_PX: Record<'xs' | 'sm' | 'md' | 'lg', number> = {
  xs: 16,
  sm: 20,
  md: 24,
  lg: 32,
};

export const PoiCategoryIcon: React.FC<PoiCategoryIconProps> = ({
  category,
  subcategory,
  symbolId,
  size = 'sm',
  className = '',
  title,
}) => {
  const resolvedId = symbolId ?? resolvePoiSymbolId(category, subcategory);
  const px = typeof size === 'number' ? size : SIZE_PX[size];
  const inner = buildPoiSymbolSvgInner(resolvedId, { includeShadow: false });

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 36 36"
      width={px}
      height={px}
      className={`inline-block shrink-0 drop-shadow-sm ${className}`.trim()}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
};
