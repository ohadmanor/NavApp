import type { MapNavigationOrientation } from './NavigationHeadingService';

/**
 * Three-state My Location button mode:
 * - `'none'`: Default idle state — do not acquire GPS and do not track location.
 * - `'once'`: Blue state — acquire fix and jump to user location once; returns to `'none'` on any map operation or after 5 minutes.
 * - `'tracking'`: Green state — continuous GPS tracking locked to screen center; also activates `'3d-pov'` by default.
 */
export type LocationTrackingMode = 'none' | 'once' | 'tracking';

/**
 * Three-state Zero-to-North / Orientation button mode:
 * - `'2d-north'`: Default 2D North-Up (black icon).
 * - `'2d-pov'`: 2D POV / Heading-Up (red icon).
 * - `'3d-pov'`: 3D POV / Heading-Up (green fill with black outline).
 */
export type NorthPovMode = '2d-north' | '2d-pov' | '3d-pov';

export const LOCATION_ONCE_TIMEOUT_MS = 5 * 60 * 1000;
export const PITCH_3D_ENTER_DEG = 8;
export const PITCH_3D_EXIT_DEG = 3;
export const NORTH_BEARING_SNAP_TOLERANCE_DEG = 2;

export function normalizeBearingDeltaDeg(bearingDeg: number): number {
  if (!Number.isFinite(bearingDeg)) return 0;
  return ((((bearingDeg + 180) % 360) + 360) % 360) - 180;
}

export type LocationModeTransitionAction =
  | 'press-location'
  | 'map-operation'
  | 'timeout-5min'
  | 'activate-tracking'
  | 'deactivate-to-none';

export interface LocationModeTransitionResult {
  locationMode: LocationTrackingMode;
  northMode: NorthPovMode;
  isFollowingUser: boolean;
  shouldJumpOnce: boolean;
  shouldClearMarker: boolean;
}

export function advanceLocationMode(current: LocationTrackingMode): LocationTrackingMode {
  if (current === 'none') return 'once';
  if (current === 'once') return 'tracking';
  return 'none';
}

export function advanceNorthMode(current: NorthPovMode): NorthPovMode {
  if (current === '2d-north') return '2d-pov';
  if (current === '2d-pov') return '3d-pov';
  return '2d-north';
}

export function isPovNorthMode(mode: NorthPovMode): boolean {
  return mode === '2d-pov' || mode === '3d-pov';
}

export function is3dNorthMode(mode: NorthPovMode): boolean {
  return mode === '3d-pov';
}

export function toMapNavOrientation(mode: NorthPovMode): MapNavigationOrientation {
  return isPovNorthMode(mode) ? 'heading-up' : 'north-up';
}

export function shouldRunGpsWatch(opts: {
  locationMode: LocationTrackingMode;
  isRecordingTrack: boolean;
  isNavigationActive: boolean;
  isLiveSharingActive: boolean;
}): boolean {
  return (
    opts.locationMode !== 'none' ||
    opts.isRecordingTrack ||
    opts.isNavigationActive ||
    opts.isLiveSharingActive
  );
}

/**
 * Pure state-transition resolver for My Location (1-a/1-b/1-c) and Zero-to-North coupling (1-c -> 2-c).
 */
export function resolveLocationModeTransition(
  currentLocation: LocationTrackingMode,
  currentNorth: NorthPovMode,
  action: LocationModeTransitionAction
): LocationModeTransitionResult {
  if (action === 'press-location') {
    const nextLocation = advanceLocationMode(currentLocation);
    if (nextLocation === 'once') {
      return {
        locationMode: 'once',
        northMode: currentNorth,
        isFollowingUser: false,
        shouldJumpOnce: true,
        shouldClearMarker: false,
      };
    }
    if (nextLocation === 'tracking') {
      return {
        locationMode: 'tracking',
        northMode: '3d-pov',
        isFollowingUser: true,
        shouldJumpOnce: false,
        shouldClearMarker: false,
      };
    }
    return {
      locationMode: 'none',
      northMode: currentNorth,
      isFollowingUser: false,
      shouldJumpOnce: false,
      shouldClearMarker: true,
    };
  }

  if (action === 'activate-tracking') {
    return {
      locationMode: 'tracking',
      northMode: '3d-pov',
      isFollowingUser: true,
      shouldJumpOnce: false,
      shouldClearMarker: false,
    };
  }

  if (action === 'deactivate-to-none') {
    return {
      locationMode: 'none',
      northMode: '2d-north',
      isFollowingUser: false,
      shouldJumpOnce: false,
      shouldClearMarker: true,
    };
  }

  if (action === 'map-operation') {
    if (currentLocation === 'once') {
      return {
        locationMode: 'none',
        northMode: currentNorth,
        isFollowingUser: false,
        shouldJumpOnce: false,
        shouldClearMarker: false,
      };
    }
    return {
      locationMode: currentLocation,
      northMode: currentNorth,
      isFollowingUser: currentLocation === 'tracking',
      shouldJumpOnce: false,
      shouldClearMarker: false,
    };
  }

  // timeout-5min
  if (currentLocation === 'once') {
    return {
      locationMode: 'none',
      northMode: currentNorth,
      isFollowingUser: false,
      shouldJumpOnce: false,
      shouldClearMarker: true,
    };
  }
  return {
    locationMode: currentLocation,
    northMode: currentNorth,
    isFollowingUser: currentLocation === 'tracking',
    shouldJumpOnce: false,
    shouldClearMarker: false,
  };
}

export interface NorthModeTransitionOptions {
  currentBearingDeg?: number;
  isFollowingUser?: boolean;
}

/**
 * Pure state-transition resolver for Zero-to-North (2-a -> 2-b -> 2-c -> 2-a).
 * When in 2d-north and manually rotated off-North, the first press zeroes bearing back to 2d-north (North-Up).
 * Coupling is strictly one-way (1-c -> 2-c): entering 2-c (3D POV) must never
 * automatically activate 1-c (continuous tracking) or enable GPS watching.
 */
export function resolveNorthModeTransition(
  currentLocation: LocationTrackingMode,
  currentNorth: NorthPovMode,
  options?: NorthModeTransitionOptions
): LocationModeTransitionResult {
  const isRotatedOffNorthIn2d =
    currentNorth === '2d-north' &&
    !options?.isFollowingUser &&
    Math.abs(normalizeBearingDeltaDeg(options?.currentBearingDeg ?? 0)) >=
      NORTH_BEARING_SNAP_TOLERANCE_DEG;
  return {
    locationMode: currentLocation,
    northMode: isRotatedOffNorthIn2d ? '2d-north' : advanceNorthMode(currentNorth),
    isFollowingUser: currentLocation === 'tracking',
    shouldJumpOnce: false,
    shouldClearMarker: false,
  };
}

/**
 * Syncs Zero-to-North mode with user pitch gestures (right-mouse drag up/down or two-finger pitch),
 * using hysteresis between PITCH_3D_EXIT_DEG and PITCH_3D_ENTER_DEG to avoid flicker.
 */
export function resolveNorthModeFromMapPitch(
  currentNorth: NorthPovMode,
  pitchDeg: number,
  fallback2dMode: '2d-north' | '2d-pov' = '2d-north'
): NorthPovMode {
  if (!Number.isFinite(pitchDeg)) return currentNorth;
  if (pitchDeg >= PITCH_3D_ENTER_DEG) return '3d-pov';
  if (pitchDeg <= PITCH_3D_EXIT_DEG && currentNorth === '3d-pov') {
    return fallback2dMode;
  }
  return currentNorth;
}

/**
 * Syncs Zero-to-North mode with manual horizontal rotation (right-mouse drag left/right or two-finger twist).
 * Leaving 2d-pov on manual free rotation lets the 2d-north compass rotate live with map bearing.
 */
export function resolveNorthModeFromManualRotate(
  currentNorth: NorthPovMode,
  isFollowingUser: boolean
): NorthPovMode {
  if (!isFollowingUser && currentNorth === '2d-pov') {
    return '2d-north';
  }
  return currentNorth;
}
