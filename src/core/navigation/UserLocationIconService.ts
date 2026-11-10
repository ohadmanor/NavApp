import {
  computeScreenRotationDeg,
  normalizeHeadingDeg,
} from './NavigationHeadingService';

export type UserIconCategory = 'default' | 'vehicles' | 'outdoor' | 'tactical' | 'web';

export interface UserLocationIconOption {
  id: string;
  labelHe: string;
  category: UserIconCategory;
  svgUrl?: string;
  inlineSvg?: string;
  rotateWithHeading?: boolean;
}

export interface UserLocationIconPreference {
  icon: UserLocationIconOption;
  accentColor: string;
}

export const USER_ICON_ACCENT_COLORS: Array<{ id: string; labelHe: string; hex: string }> = [
  { id: 'sky', labelHe: 'כחול ניווט', hex: '#0ea5e9' },
  { id: 'emerald', labelHe: 'ירוק שטח', hex: '#10b981' },
  { id: 'amber', labelHe: 'כתום טקטי', hex: '#f59e0b' },
  { id: 'crimson', labelHe: 'אדום חילוץ', hex: '#ef4444' },
  { id: 'violet', labelHe: 'סגול סינגל', hex: '#8b5cf6' },
  { id: 'obsidian', labelHe: 'שחור כהה', hex: '#0f172a' },
];

export const BUILT_IN_USER_ICONS: UserLocationIconOption[] = [
  {
    id: 'gps-puck',
    labelHe: 'נקודת GPS',
    category: 'default',
    rotateWithHeading: true,
  },
  {
    id: 'car-4wd',
    labelHe: 'ג׳יפ 4x4',
    category: 'vehicles',
    svgUrl: '/assets/user-icons/car-4wd.svg',
    rotateWithHeading: true,
  },
  {
    id: 'car-suv',
    labelHe: 'רכב שטח SUV',
    category: 'vehicles',
    svgUrl: '/assets/user-icons/car-suv.svg',
    rotateWithHeading: false,
  },
  {
    id: 'truck',
    labelHe: 'טנדר שטח',
    category: 'vehicles',
    svgUrl: '/assets/user-icons/truck.svg',
    rotateWithHeading: false,
  },
  {
    id: 'atv',
    labelHe: 'טרקטורון / RZR',
    category: 'vehicles',
    svgUrl: '/assets/user-icons/atv.svg',
    rotateWithHeading: false,
  },
  {
    id: 'motorbike',
    labelHe: 'אופנוע שטח',
    category: 'vehicles',
    svgUrl: '/assets/user-icons/motorbike.svg',
    rotateWithHeading: false,
  },
  {
    id: 'bike',
    labelHe: 'אופני הרים',
    category: 'outdoor',
    svgUrl: '/assets/user-icons/bike.svg',
    rotateWithHeading: false,
  },
  {
    id: 'walk',
    labelHe: 'מטייל',
    category: 'outdoor',
    svgUrl: '/assets/user-icons/walk.svg',
    rotateWithHeading: false,
  },
  {
    id: 'trekking',
    labelHe: 'תרמילאי',
    category: 'outdoor',
    svgUrl: '/assets/user-icons/trekking.svg',
    rotateWithHeading: false,
  },
  {
    id: 'run',
    labelHe: 'ריצת שטח',
    category: 'outdoor',
    svgUrl: '/assets/user-icons/run.svg',
    rotateWithHeading: false,
  },
  {
    id: 'navigation-arrow',
    labelHe: 'חץ ניווט',
    category: 'tactical',
    svgUrl: '/assets/user-icons/navigation-arrow.svg',
    rotateWithHeading: true,
  },
  {
    id: 'compass',
    labelHe: 'מצפן',
    category: 'tactical',
    svgUrl: '/assets/user-icons/compass.svg',
    rotateWithHeading: false,
  },
  {
    id: 'drone',
    labelHe: 'רחפן',
    category: 'tactical',
    svgUrl: '/assets/user-icons/drone.svg',
    rotateWithHeading: false,
  },
  {
    id: 'dog',
    labelHe: 'כלב / גשש',
    category: 'outdoor',
    svgUrl: '/assets/user-icons/dog.svg',
    rotateWithHeading: false,
  },
  {
    id: 'horse',
    labelHe: 'סוס',
    category: 'outdoor',
    svgUrl: '/assets/user-icons/horse.svg',
    rotateWithHeading: false,
  },
  {
    id: 'tent',
    labelHe: 'מחנה / חניון',
    category: 'outdoor',
    svgUrl: '/assets/user-icons/tent.svg',
    rotateWithHeading: false,
  },
];

const PREF_STORAGE_KEY = 'navapp.userPositionIcon.v1';
const CUSTOM_ICONS_STORAGE_KEY = 'navapp.customWebUserIcons.v1';

const svgMemoryCache = new Map<string, string>();
const listeners = new Set<(pref: UserLocationIconPreference) => void>();

export function sanitizeSvgMarkup(rawSvg: string): string {
  if (!rawSvg || typeof rawSvg !== 'string') return '';
  let trimmed = rawSvg.trim();
  const svgStart = trimmed.search(/<svg\b/i);
  if (svgStart < 0 || !/<\/svg>/i.test(trimmed)) return '';
  if (svgStart > 0) {
    trimmed = trimmed.slice(svgStart);
  }
  // Strip any script/foreignObject tags and inline event handlers
  return trimmed
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<svg\b([^>]*)>/i, (_full, attrs: string) => {
      const cleanedAttrs = attrs
        .replace(/\b(width|height|class|style)\s*=\s*(['"]).*?\2/gi, '')
        .trim();
      const fillAttr = /\bfill\s*=/i.test(cleanedAttrs) ? '' : ' fill="currentColor"';
      return `<svg ${cleanedAttrs}${fillAttr} width="20" height="20" style="display:block;color:#ffffff">`;
    });
}

function getDefaultPreference(): UserLocationIconPreference {
  return {
    icon: BUILT_IN_USER_ICONS[0],
    accentColor: USER_ICON_ACCENT_COLORS[0].hex,
  };
}

export class UserLocationIconService {
  static getPreference(): UserLocationIconPreference {
    if (typeof window === 'undefined' || !window.localStorage) {
      return getDefaultPreference();
    }
    try {
      const raw = window.localStorage.getItem(PREF_STORAGE_KEY);
      if (!raw) return getDefaultPreference();
      const parsed = JSON.parse(raw) as Partial<UserLocationIconPreference>;
      if (!parsed?.icon?.id) return getDefaultPreference();
      const builtIn = BUILT_IN_USER_ICONS.find((i) => i.id === parsed.icon!.id);
      const mergedIcon: UserLocationIconOption = builtIn
        ? { ...builtIn, inlineSvg: parsed.icon.inlineSvg || builtIn.inlineSvg }
        : {
            id: String(parsed.icon.id),
            labelHe: String(parsed.icon.labelHe || parsed.icon.id),
            category: parsed.icon.category || 'web',
            svgUrl: parsed.icon.svgUrl,
            inlineSvg: parsed.icon.inlineSvg,
            rotateWithHeading: Boolean(parsed.icon.rotateWithHeading),
          };
      if (mergedIcon.inlineSvg) {
        svgMemoryCache.set(mergedIcon.id, mergedIcon.inlineSvg);
      }
      return {
        icon: mergedIcon,
        accentColor:
          typeof parsed.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.accentColor)
            ? parsed.accentColor
            : USER_ICON_ACCENT_COLORS[0].hex,
      };
    } catch {
      return getDefaultPreference();
    }
  }

  static getCustomWebIcons(): UserLocationIconOption[] {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    try {
      const raw = window.localStorage.getItem(CUSTOM_ICONS_STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter((item) => item && typeof item.id === 'string');
    } catch {
      return [];
    }
  }

  private static saveCustomWebIcon(icon: UserLocationIconOption): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const existing = this.getCustomWebIcons().filter((i) => i.id !== icon.id);
      const next = [icon, ...existing].slice(0, 24);
      window.localStorage.setItem(CUSTOM_ICONS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota errors
    }
  }

  static async setPreference(nextPref: UserLocationIconPreference): Promise<UserLocationIconPreference> {
    let resolvedIcon = { ...nextPref.icon };
    if (resolvedIcon.id !== 'gps-puck' && !resolvedIcon.inlineSvg && resolvedIcon.svgUrl) {
      const loadedSvg = await this.loadIconSvgMarkup(resolvedIcon);
      if (loadedSvg) {
        resolvedIcon.inlineSvg = loadedSvg;
      }
    }

    const finalPref: UserLocationIconPreference = {
      icon: resolvedIcon,
      accentColor: nextPref.accentColor || USER_ICON_ACCENT_COLORS[0].hex,
    };

    if (finalPref.icon.category === 'web' && finalPref.icon.inlineSvg) {
      this.saveCustomWebIcon(finalPref.icon);
    }

    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(finalPref));
      } catch {
        // Ignore storage quota errors
      }
    }

    for (const listener of listeners) {
      listener(finalPref);
    }
    return finalPref;
  }

  static subscribe(listener: (pref: UserLocationIconPreference) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  static async loadIconSvgMarkup(icon: UserLocationIconOption): Promise<string | null> {
    if (icon.id === 'gps-puck') return null;
    if (icon.inlineSvg) {
      const sanitized = sanitizeSvgMarkup(icon.inlineSvg);
      if (sanitized) {
        svgMemoryCache.set(icon.id, sanitized);
        return sanitized;
      }
    }
    const cached = svgMemoryCache.get(icon.id);
    if (cached) return cached;
    if (!icon.svgUrl || typeof fetch !== 'function') return null;

    try {
      const res = await fetch(icon.svgUrl);
      if (!res.ok) return null;
      const raw = await res.text();
      const sanitized = sanitizeSvgMarkup(raw);
      if (!sanitized) return null;
      svgMemoryCache.set(icon.id, sanitized);
      return sanitized;
    } catch {
      return null;
    }
  }

  /**
   * Searches Iconify's public open-source web icon catalog (Tabler, MDI, Maki, etc.)
   * and returns selectable icon options that can be fetched and cached offline.
   */
  static async searchWebIcons(query: string, limit = 16): Promise<UserLocationIconOption[]> {
    const trimmed = query.trim();
    if (!trimmed || typeof fetch !== 'function') return [];
    const url = `https://api.iconify.design/search?query=${encodeURIComponent(trimmed)}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Web icon search failed (${res.status})`);
    }
    const data = (await res.json()) as { icons?: string[] };
    const names = Array.isArray(data.icons) ? data.icons : [];
    return names
      .filter((full) => typeof full === 'string' && full.includes(':'))
      .map((full) => {
        const [prefix, name] = full.split(':');
        return {
          id: `web-${prefix}-${name}`,
          labelHe: name.replace(/[-_]+/g, ' '),
          category: 'web' as const,
          svgUrl: `https://api.iconify.design/${encodeURIComponent(prefix)}/${encodeURIComponent(name)}.svg?width=32&height=32`,
          rotateWithHeading: false,
        };
      });
  }

  /**
   * Renders or updates a MapLibre user position marker DOM container with the chosen icon,
   * accent color, pulsing accuracy halo, and Google Maps-style directional beam & arrow.
   */
  static renderMarkerElement(
    root: HTMLElement,
    pref: UserLocationIconPreference,
    heading: number | null,
    mapBearing = 0,
    isNavigationActive = false
  ): void {
    const color = pref.accentColor || '#0ea5e9';
    const isDefaultDot = pref.icon.id === 'gps-puck';
    const sizePx = isDefaultDot ? 72 : 76;
    const renderKey = `${pref.icon.id}|${color}|${pref.icon.svgUrl || ''}|${Boolean(pref.icon.inlineSvg)}`;
    const safeColorToken = color.replace(/[^a-zA-Z0-9]/g, '') || '0ea5e9';

    // CRITICAL: Preserve MapLibre's `.maplibregl-marker` class & `position: absolute; top: 0; left: 0`
    // Never overwrite root.className or add Tailwind's `.relative` on the outer marker element.
    root.classList.add('pointer-events-none', 'select-none');
    root.style.position = 'absolute';
    root.style.top = '0';
    root.style.left = '0';
    root.style.zIndex = '20';
    root.style.width = `${sizePx}px`;
    root.style.height = `${sizePx}px`;
    root.setAttribute('aria-label', `המיקום הנוכחי שלי (${pref.icon.labelHe})`);

    if (root.dataset.iconRenderKey !== renderKey) {
      root.dataset.iconRenderKey = renderKey;
      root.innerHTML = '';

      const inner = document.createElement('div');
      inner.className = 'relative flex items-center justify-center w-full h-full';
      root.appendChild(inner);

      // Outer pulsing accuracy halo (centered over coordinates)
      const halo = document.createElement('span');
      halo.className = 'absolute w-11 h-11 rounded-full animate-ping';
      halo.style.backgroundColor = `${color}2b`;
      halo.style.border = `1px solid ${color}80`;
      halo.style.animationDuration = '2.4s';
      inner.appendChild(halo);

      // Static soft accuracy ring
      const ring = document.createElement('span');
      ring.className = 'absolute w-9 h-9 rounded-full';
      ring.style.backgroundColor = `${color}24`;
      ring.style.border = `1px solid ${color}73`;
      inner.appendChild(ring);

      // Google Maps-style directional flashlight FOV beam & forward arrow tip
      const headingWrap = document.createElement('span');
      headingWrap.dataset.role = 'heading';
      headingWrap.className = 'absolute inset-0 flex items-center justify-center';
      headingWrap.style.display = 'none';
      headingWrap.innerHTML = `<svg viewBox="-36 -36 72 72" width="${sizePx}" height="${sizePx}" style="display:block;overflow:visible;pointer-events:none"><defs><linearGradient id="navapp-fov-${safeColorToken}" x1="0" y1="0" x2="0" y2="-35" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="${color}" stop-opacity="0.62"/><stop offset="65%" stop-color="${color}" stop-opacity="0.22"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="M 0,0 L -21,-32 A 36,36 0 0,1 21,-32 Z" fill="url(#navapp-fov-${safeColorToken})"/><path d="M 0,-29 L -5.8,-19.2 L 0,-21.6 L 5.8,-19.2 Z" fill="${color}" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
      inner.appendChild(headingWrap);

      if (isDefaultDot) {
        const badge = document.createElement('span');
        badge.dataset.role = 'badge';
        badge.className =
          'relative w-6 h-6 rounded-full border-[2.5px] border-white flex items-center justify-center shadow-lg';
        badge.style.backgroundColor = color;
        badge.style.boxShadow = `0 0 12px ${color}`;

        // Stationary dot vs directional navigation chevron (like Google Maps)
        const coreDot = document.createElement('span');
        coreDot.dataset.role = 'puck-core-dot';
        coreDot.className = 'w-2.5 h-2.5 rounded-full bg-white';
        badge.appendChild(coreDot);

        const navArrow = document.createElement('span');
        navArrow.dataset.role = 'puck-nav-arrow';
        navArrow.className = 'items-center justify-center w-4 h-4';
        navArrow.style.display = 'none';
        navArrow.innerHTML =
          '<svg viewBox="0 0 24 24" width="15" height="15" style="display:block"><path fill="#ffffff" d="M12 3L19.5 19.5L12 15.8L4.5 19.5Z"/></svg>';
        badge.appendChild(navArrow);

        inner.appendChild(badge);
      } else {
        // Custom Icon Circular Badge
        const badge = document.createElement('span');
        badge.dataset.role = 'badge';
        badge.className =
          'relative w-8 h-8 rounded-full border-[2.5px] border-white flex items-center justify-center shadow-lg';
        badge.style.backgroundColor = color;
        badge.style.boxShadow = `0 2px 12px ${color}b3`;

        const iconSlot = document.createElement('span');
        iconSlot.className = 'flex items-center justify-center w-5 h-5 text-white';
        badge.appendChild(iconSlot);
        inner.appendChild(badge);

        const immediateSvg = pref.icon.inlineSvg
          ? sanitizeSvgMarkup(pref.icon.inlineSvg)
          : svgMemoryCache.get(pref.icon.id);
        if (immediateSvg) {
          iconSlot.innerHTML = immediateSvg;
        } else {
          iconSlot.innerHTML = '<span class="w-2.5 h-2.5 rounded-full bg-white/90"></span>';
          void this.loadIconSvgMarkup(pref.icon).then((loaded) => {
            if (loaded && root.dataset.iconRenderKey === renderKey && root.contains(iconSlot)) {
              iconSlot.innerHTML = loaded;
            }
          });
        }
      }
    }

    this.updateMarkerDirection(root, pref, heading, mapBearing, isNavigationActive);
  }

  /**
   * Updates only CSS rotation transforms for the directional cone and inner chevron/icon
   * in O(1) without rebuilding DOM nodes, keeping marker screen orientation synced at 60fps
   * across North-Up and Heading-Up camera rotations.
   */
  static updateMarkerDirection(
    root: HTMLElement,
    pref: UserLocationIconPreference,
    heading: number | null,
    mapBearing = 0,
    isNavigationActive = false
  ): void {
    const hasSensorHeading = typeof heading === 'number' && Number.isFinite(heading);
    const effectiveWorldHeading = hasSensorHeading
      ? normalizeHeadingDeg(heading)
      : isNavigationActive
        ? 0
        : null;
    const screenDeg =
      effectiveWorldHeading !== null
        ? computeScreenRotationDeg(effectiveWorldHeading, Number.isFinite(mapBearing) ? mapBearing : 0)
        : null;

    const headingWrap = root.querySelector<HTMLElement>('[data-role="heading"]');
    if (headingWrap) {
      if (screenDeg !== null) {
        headingWrap.classList.remove('hidden');
        headingWrap.style.display = 'flex';
        headingWrap.style.transform = `rotate(${screenDeg}deg)`;
      } else {
        headingWrap.classList.add('hidden');
        headingWrap.style.display = 'none';
        headingWrap.style.transform = '';
      }
    }

    const coreDot = root.querySelector<HTMLElement>('[data-role="puck-core-dot"]');
    const puckArrow = root.querySelector<HTMLElement>('[data-role="puck-nav-arrow"]');
    if (coreDot && puckArrow) {
      if (screenDeg !== null) {
        coreDot.classList.add('hidden');
        coreDot.style.display = 'none';
        puckArrow.classList.remove('hidden');
        puckArrow.style.display = 'flex';
      } else {
        coreDot.classList.remove('hidden');
        coreDot.style.display = 'block';
        puckArrow.classList.add('hidden');
        puckArrow.style.display = 'none';
      }
    }

    const badge = root.querySelector<HTMLElement>('[data-role="badge"]');
    if (badge) {
      const shouldRotateBadge =
        (pref.icon.id === 'gps-puck' || Boolean(pref.icon.rotateWithHeading)) && screenDeg !== null;
      badge.style.transform = shouldRotateBadge ? `rotate(${screenDeg}deg)` : '';
    }
  }
}
