import type { SavedRouteRecord } from '../db/NavDatabase';

export type RouteMapDisplayMode = 'navigating' | 'editing' | 'planning' | 'selecting' | 'idle';

export interface RouteDisplayContext {
  /** User is actively in the Route Planner panel/overlay */
  isPlanning: boolean;
  /** User is actively editing an existing route in the Route Planner */
  isEditing: boolean;
  /** User has the Routes selector/drawer open to preview/select routes */
  isSelecting: boolean;
  /** User has started active route navigation ("התחל ניווט במסלול") */
  isNavigating: boolean;
  /** Route ID currently open in planner waypoint edit mode (static copy hidden) */
  editingRouteId?: string | null;
  /** Explicit user-pinned background reference route IDs (only shown while planning or selecting) */
  pinnedBackgroundIds?: ReadonlySet<string> | string[];
  /** Whether background reference routes are visible while inside the Route Planner */
  showBackgroundWhilePlanning?: boolean;
}

export interface ResolvedMapRouteDisplay {
  mode: RouteMapDisplayMode;
  /** Primary route rendered on active-route-src & active-route-endpoints-src */
  activeRouteToDisplay: SavedRouteRecord | null;
  /** Explicit reference routes rendered on saved-routes-src behind active/planner overlays */
  backgroundRoutesToDisplay: SavedRouteRecord[];
  /** Route ID suppressed from static GeoJSON layers because live planner legs represent it */
  editingHiddenId: string | null;
  /** Whether the interactive planner GeoJSON layers (legs/waypoints/snap preview) should render */
  shouldShowPlanOverlay: boolean;
}

/**
 * Deterministic visibility state machine (PRD 2):
 * A route renders on the map ONLY when at least one of these holds:
 *   (a) User is planning a route or selecting from the Routes drawer
 *   (b) User is editing an existing route
 *   (c) User selected a route and pressed Start Navigation
 * When none hold (idle map), NO routes clutter the map.
 */
export function resolveMapRouteDisplay(
  allRoutes: SavedRouteRecord[],
  activeRoute: SavedRouteRecord | null,
  ctx: RouteDisplayContext
): ResolvedMapRouteDisplay {
  const pinnedSet: ReadonlySet<string> =
    ctx.pinnedBackgroundIds instanceof Set
      ? ctx.pinnedBackgroundIds
      : new Set(ctx.pinnedBackgroundIds || []);

  const showBgPlanner = ctx.showBackgroundWhilePlanning !== false;
  const editingHiddenId =
    ctx.isPlanning && ctx.editingRouteId ? ctx.editingRouteId : null;

  let mode: RouteMapDisplayMode = 'idle';
  if (ctx.isNavigating && activeRoute) {
    mode = 'navigating';
  } else if (ctx.isEditing && ctx.isPlanning) {
    mode = 'editing';
  } else if (ctx.isPlanning) {
    mode = 'planning';
  } else if (ctx.isSelecting) {
    mode = 'selecting';
  }

  // Primary active route display:
  // Shown only during Navigating (c), Editing (b), or Selecting in Routes UI (a),
  // and suppressed if live planner legs are currently replacing the exact same route.
  const canShowActive = ctx.isNavigating || ctx.isSelecting || ctx.isEditing;
  const activeRouteToDisplay =
    canShowActive && activeRoute && activeRoute.id !== editingHiddenId ? activeRoute : null;

  // Background reference routes ("השאר מסלול ברקע"):
  // Only rendered while comparing in Routes drawer OR when enabled while Planning.
  const allowBackgroundRefs =
    pinnedSet.size > 0 && (ctx.isSelecting || (ctx.isPlanning && showBgPlanner));

  const backgroundRoutesToDisplay = allowBackgroundRefs
    ? allRoutes.filter(
        (r) =>
          pinnedSet.has(r.id) &&
          r.id !== activeRouteToDisplay?.id &&
          r.id !== editingHiddenId
      )
    : [];

  return {
    mode,
    activeRouteToDisplay,
    backgroundRoutesToDisplay,
    editingHiddenId,
    shouldShowPlanOverlay: ctx.isPlanning,
  };
}
