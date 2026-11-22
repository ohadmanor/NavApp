import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LOCATION_ONCE_TIMEOUT_MS,
  PITCH_3D_ENTER_DEG,
  PITCH_3D_EXIT_DEG,
  advanceLocationMode,
  advanceNorthMode,
  is3dNorthMode,
  isPovNorthMode,
  normalizeBearingDeltaDeg,
  resolveLocationModeTransition,
  resolveNorthModeFromManualRotate,
  resolveNorthModeFromMapPitch,
  resolveNorthModeTransition,
  shouldRunGpsWatch,
  toMapNavOrientation,
} from '../navigation/MapControlModes';

describe('Map Control Modes: My Location (3-state) & Zero-to-North (3-state)', () => {
  it('cycles My Location sequentially: none -> once -> tracking -> none without requiring double click', () => {
    expect(advanceLocationMode('none')).toBe('once');
    expect(advanceLocationMode('once')).toBe('tracking');
    expect(advanceLocationMode('tracking')).toBe('none');
  });

  it('cycles Zero-to-North sequentially: 2d-north -> 2d-pov -> 3d-pov -> 2d-north', () => {
    expect(advanceNorthMode('2d-north')).toBe('2d-pov');
    expect(advanceNorthMode('2d-pov')).toBe('3d-pov');
    expect(advanceNorthMode('3d-pov')).toBe('2d-north');

    expect(isPovNorthMode('2d-north')).toBe(false);
    expect(isPovNorthMode('2d-pov')).toBe(true);
    expect(isPovNorthMode('3d-pov')).toBe(true);

    expect(is3dNorthMode('2d-north')).toBe(false);
    expect(is3dNorthMode('2d-pov')).toBe(false);
    expect(is3dNorthMode('3d-pov')).toBe(true);

    expect(toMapNavOrientation('2d-north')).toBe('north-up');
    expect(toMapNavOrientation('2d-pov')).toBe('heading-up');
    expect(toMapNavOrientation('3d-pov')).toBe('heading-up');
  });

  it('activates 2-c (3D POV up) whenever 1-c (continuous tracking) is activated', () => {
    const step1 = resolveLocationModeTransition('none', '2d-north', 'press-location');
    expect(step1).toEqual({
      locationMode: 'once',
      northMode: '2d-north',
      isFollowingUser: false,
      shouldJumpOnce: true,
      shouldClearMarker: false,
    });

    const step2 = resolveLocationModeTransition(
      step1.locationMode,
      step1.northMode,
      'press-location'
    );
    expect(step2).toEqual({
      locationMode: 'tracking',
      northMode: '3d-pov',
      isFollowingUser: true,
      shouldJumpOnce: false,
      shouldClearMarker: false,
    });

    // Even if user was on 2d-pov earlier, entering 1-c activates 2-c
    const from2dPov = resolveLocationModeTransition('once', '2d-pov', 'press-location');
    expect(from2dPov.northMode).toBe('3d-pov');
    expect(from2dPov.locationMode).toBe('tracking');

    const step3 = resolveLocationModeTransition(
      step2.locationMode,
      step2.northMode,
      'press-location'
    );
    expect(step3).toEqual({
      locationMode: 'none',
      northMode: '3d-pov',
      isFollowingUser: false,
      shouldJumpOnce: false,
      shouldClearMarker: true,
    });
  });

  it('returns once (1-b) to none (1-a) on map operation or 5-min timeout, while keeping continuous tracking (1-c) locked', () => {
    expect(LOCATION_ONCE_TIMEOUT_MS).toBe(5 * 60 * 1000);

    const onMapOp = resolveLocationModeTransition('once', '2d-north', 'map-operation');
    expect(onMapOp.locationMode).toBe('none');
    expect(onMapOp.isFollowingUser).toBe(false);
    expect(onMapOp.shouldClearMarker).toBe(false);

    const onTimeout = resolveLocationModeTransition('once', '2d-north', 'timeout-5min');
    expect(onTimeout.locationMode).toBe('none');
    expect(onTimeout.isFollowingUser).toBe(false);
    expect(onTimeout.shouldClearMarker).toBe(true);

    // Map operations must NOT cancel continuous tracking (only pressing once more returns to none)
    const trackingOnMapOp = resolveLocationModeTransition('tracking', '3d-pov', 'map-operation');
    expect(trackingOnMapOp.locationMode).toBe('tracking');
    expect(trackingOnMapOp.isFollowingUser).toBe(true);
  });

  it('only watches GPS when location mode is active or recording/navigating/sharing needs it', () => {
    expect(
      shouldRunGpsWatch({
        locationMode: 'none',
        isRecordingTrack: false,
        isNavigationActive: false,
        isLiveSharingActive: false,
      })
    ).toBe(false);

    expect(
      shouldRunGpsWatch({
        locationMode: 'once',
        isRecordingTrack: false,
        isNavigationActive: false,
        isLiveSharingActive: false,
      })
    ).toBe(true);

    expect(
      shouldRunGpsWatch({
        locationMode: 'tracking',
        isRecordingTrack: false,
        isNavigationActive: false,
        isLiveSharingActive: false,
      })
    ).toBe(true);

    expect(
      shouldRunGpsWatch({
        locationMode: 'none',
        isRecordingTrack: true,
        isNavigationActive: false,
        isLiveSharingActive: false,
      })
    ).toBe(true);
  });

  it('enforces one-way coupling: pressing Zero-to-North into 2-c (3D POV) never activates 1-c (continuous tracking)', () => {
    // From 1-a ('none'): cycling 2-a -> 2-b -> 2-c -> 2-a keeps locationMode='none', isFollowingUser=false, and GPS off
    const to2dPovFromNone = resolveNorthModeTransition('none', '2d-north');
    expect(to2dPovFromNone).toEqual({
      locationMode: 'none',
      northMode: '2d-pov',
      isFollowingUser: false,
      shouldJumpOnce: false,
      shouldClearMarker: false,
    });

    const to3dPovFromNone = resolveNorthModeTransition(
      to2dPovFromNone.locationMode,
      to2dPovFromNone.northMode
    );
    expect(to3dPovFromNone).toEqual({
      locationMode: 'none',
      northMode: '3d-pov',
      isFollowingUser: false,
      shouldJumpOnce: false,
      shouldClearMarker: false,
    });
    expect(
      shouldRunGpsWatch({
        locationMode: to3dPovFromNone.locationMode,
        isRecordingTrack: false,
        isNavigationActive: false,
        isLiveSharingActive: false,
      })
    ).toBe(false);

    // From 1-b ('once'): entering 2-c ('3d-pov') keeps locationMode='once' and does NOT promote to 1-c ('tracking')
    const to3dPovFromOnce = resolveNorthModeTransition('once', '2d-pov');
    expect(to3dPovFromOnce.northMode).toBe('3d-pov');
    expect(to3dPovFromOnce.locationMode).toBe('once');
    expect(to3dPovFromOnce.isFollowingUser).toBe(false);

    // From 1-c ('tracking'): manually cycling north mode leaves continuous tracking active until user changes location mode
    const fromTracking = resolveNorthModeTransition('tracking', '3d-pov');
    expect(fromTracking.northMode).toBe('2d-north');
    expect(fromTracking.locationMode).toBe('tracking');
    expect(fromTracking.isFollowingUser).toBe(true);
  });

  it('wires both 3-state Location and Zero-to-North controls in App.tsx with one-way 1-c -> 2-c coupling', () => {
    const appSrc = fs.readFileSync('src/App.tsx', 'utf-8');
    expect(appSrc).toContain('LOCATION_ONCE_TIMEOUT_MS');
    expect(appSrc).toContain('renderLocationModeButton');
    expect(appSrc).toContain('renderNorthModeButton');
    expect(appSrc).toContain('data-location-mode={locationMode}');
    expect(appSrc).toContain('data-north-mode={northMode}');

    const cycleMatch = appSrc.match(
      /const handleCycleNorthMode = \(\) => \{[\s\S]*?const handleToggleDesktopFreeNavigation/
    );
    expect(cycleMatch).not.toBeNull();
    const cycleBody = cycleMatch?.[0] ?? '';
    expect(cycleBody).toContain('resolveNorthModeTransition');
    expect(cycleBody).not.toContain('setLocationMode');
    expect(cycleBody).not.toContain('setIsFollowingUser');
    expect(cycleBody).not.toContain('applyLocationTransition');

    // Guard against jumping to GPS when location mode is off ('none')
    expect(appSrc).toMatch(
      /if\s*\(res\.locationMode\s*===\s*'none'\)\s*\{\s*pendingLocateFlyRef\.current\s*=\s*false;/
    );
    expect(appSrc).toContain("if (currentLoc && map && locationModeRef.current !== 'none')");

    // 3D mode is controlled exclusively via Zero-to-North (2-c), not inside the Map Style (Day/Night) menu
    const layerSheetSrc = fs.readFileSync('src/components/map/LayerSwitcherSheet.tsx', 'utf-8');
    expect(layerSheetSrc).not.toContain('תבליט 3D');
    expect(layerSheetSrc).not.toContain('onToggle3D');

    // 3D-POV button renders the modern 3D glyph filled green (#22c55e) with black outline (#000000)
    const threeDSectionMatch = appSrc.match(/\{northMode === '3d-pov' && \([\s\S]*?\)\}/);
    const threeDSection = threeDSectionMatch?.[0] ?? '';
    expect(threeDSection).toContain('Modern 3D glyph');
    expect(threeDSection).toContain('#22c55e');
    expect(threeDSection).toContain('#000000');

    // Gesture sync wiring: map pitch & rotate gestures sync northMode + live SVG compass rotation
    expect(appSrc).toContain("map.on('pitch'");
    expect(appSrc).toContain("map.on('pitchend'");
    expect(appSrc).toContain("map.on('rotateend'");
    expect(appSrc).toContain('resolveNorthModeFromMapPitch');
    expect(appSrc).toContain('resolveNorthModeFromManualRotate');
    expect(appSrc).toContain('programmaticNorthControl: true');
    expect(appSrc).toContain('programmaticNorthUntilRef');
    expect(appSrc).not.toContain('className="w-[22px] h-[22px] transition-transform"');
  });

  it('syncs Zero-to-North with map pitch (3D tilt up/down) and manual map rotation gestures', () => {
    // Tilting up past PITCH_3D_ENTER_DEG via right-click vertical drag activates '3d-pov'
    expect(resolveNorthModeFromMapPitch('2d-north', PITCH_3D_ENTER_DEG - 1)).toBe('2d-north');
    expect(resolveNorthModeFromMapPitch('2d-north', PITCH_3D_ENTER_DEG)).toBe('3d-pov');
    expect(resolveNorthModeFromMapPitch('2d-pov', 35)).toBe('3d-pov');

    // Hysteresis holds '3d-pov' above PITCH_3D_EXIT_DEG and exits cleanly when flattened
    expect(resolveNorthModeFromMapPitch('3d-pov', PITCH_3D_EXIT_DEG + 1)).toBe('3d-pov');
    expect(resolveNorthModeFromMapPitch('3d-pov', PITCH_3D_EXIT_DEG)).toBe('2d-north');
    expect(resolveNorthModeFromMapPitch('3d-pov', 0)).toBe('2d-north');

    // Manual horizontal swipe/rotation returns '2d-pov' to '2d-north' so the compass needle rotates in sync,
    // while staying in '3d-pov' if pitched or leaving '2d-pov' during active GPS following
    expect(resolveNorthModeFromManualRotate('2d-pov', false)).toBe('2d-north');
    expect(resolveNorthModeFromManualRotate('3d-pov', false)).toBe('3d-pov');
    expect(resolveNorthModeFromManualRotate('2d-north', false)).toBe('2d-north');
    expect(resolveNorthModeFromManualRotate('2d-pov', true)).toBe('2d-pov');

    // Pressing Zero-to-North while manually rotated off-North in '2d-north' snaps back to North (0 deg) first;
    // pressing once upright cycles '2d-north' -> '2d-pov' -> '3d-pov'
    expect(normalizeBearingDeltaDeg(359)).toBe(-1);
    expect(normalizeBearingDeltaDeg(270)).toBe(-90);
    const snapNorth = resolveNorthModeTransition('none', '2d-north', {
      currentBearingDeg: 45,
      isFollowingUser: false,
    });
    expect(snapNorth.northMode).toBe('2d-north');

    const enterPovWhenUpright = resolveNorthModeTransition('none', '2d-north', {
      currentBearingDeg: 0.5,
      isFollowingUser: false,
    });
    expect(enterPovWhenUpright.northMode).toBe('2d-pov');
  });
});
