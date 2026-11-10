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
    rotateWithHeading: false,
  },
  {
    id: 'car-4wd',
    labelHe: 'ג׳יפ 4x4',
    category: 'vehicles',
    svgUrl: '/assets/user-icons/car-4wd.svg',
    rotateWithHeading: false,
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
  const trimmed = rawSvg.trim();
  if (!trimmed.startsWith('<svg') || !trimmed.includes('</svg>')) return '';
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
      return `<svg ${cleanedAttrs} width="20" height="20" style="display:block;color:#ffffff">`;
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
   * accent color, pulsing accuracy halo, and optional heading cone.
   */
  static renderMarkerElement(
    root: HTMLElement,
    pref: UserLocationIconPreference,
    heading: number | null
  ): void {
    const color = pref.accentColor || '#0ea5e9';
    const isDefaultDot = pref.icon.id === 'gps-puck';
    const sizePx = isDefaultDot ? 36 : 46;
    const renderKey = `${pref.icon.id}|${color}|${Boolean(pref.icon.inlineSvg)}`;

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

      // Outer pulsing accuracy halo
      const halo = document.createElement('span');
      halo.className = 'absolute inset-0 rounded-full animate-ping';
      halo.style.backgroundColor = `${color}33`;
      halo.style.border = `1px solid ${color}99`;
      halo.style.animationDuration = '2.4s';
      inner.appendChild(halo);

      // Static soft ring
      const ring = document.createElement('span');
      ring.className = 'absolute inset-1 rounded-full';
      ring.style.backgroundColor = `${color}29`;
      ring.style.border = `1px solid ${color}80`;
      inner.appendChild(ring);

      // Heading arrow cone
      const headingWrap = document.createElement('span');
      headingWrap.dataset.role = 'heading';
      headingWrap.className =
        'absolute inset-0 flex items-start justify-center transition-transform duration-300 hidden';
      const arrow = document.createElement('span');
      arrow.className =
        'w-0 h-0 -mt-1.5 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-b-[8px] drop-shadow';
      arrow.style.borderBottomColor = color;
      headingWrap.appendChild(arrow);
      inner.appendChild(headingWrap);

      if (isDefaultDot) {
        const dot = document.createElement('span');
        dot.className = 'relative w-4 h-4 rounded-full border-[2.5px] border-white';
        dot.style.backgroundColor = color;
        dot.style.boxShadow = `0 0 12px ${color}`;
        inner.appendChild(dot);
      } else {
        // Custom Icon Circular Badge
        const badge = document.createElement('span');
        badge.dataset.role = 'badge';
        badge.className =
          'relative w-8 h-8 rounded-full border-[2.5px] border-white flex items-center justify-center shadow-lg transition-transform duration-300';
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
          void this.loadIconSvgMarkup(pref.icon).then((loaded) => {
            if (loaded && iconSlot.isConnected) {
              iconSlot.innerHTML = loaded;
            }
          });
        }
      }
    }

    const headingWrap = root.querySelector<HTMLElement>('[data-role="heading"]');
    if (headingWrap) {
      if (typeof heading === 'number' && Number.isFinite(heading)) {
        headingWrap.classList.remove('hidden');
        headingWrap.style.transform = `rotate(${heading}deg)`;
      } else {
        headingWrap.classList.add('hidden');
      }
    }

    const badge = root.querySelector<HTMLElement>('[data-role="badge"]');
    if (badge) {
      if (
        pref.icon.rotateWithHeading &&
        typeof heading === 'number' &&
        Number.isFinite(heading)
      ) {
        badge.style.transform = `rotate(${heading}deg)`;
      } else {
        badge.style.transform = '';
      }
    }
  }
}
