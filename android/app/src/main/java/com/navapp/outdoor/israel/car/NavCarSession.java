package com.navapp.outdoor.israel.car;

import android.content.Intent;
import android.content.res.Configuration;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.annotation.NonNull;
import androidx.car.app.AppManager;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.ScreenManager;
import androidx.car.app.Session;
import androidx.car.app.model.DateTimeWithZone;
import androidx.car.app.model.Distance;
import androidx.car.app.navigation.NavigationManager;
import androidx.car.app.navigation.NavigationManagerCallback;
import androidx.car.app.navigation.model.Destination;
import androidx.car.app.navigation.model.Maneuver;
import androidx.car.app.navigation.model.Step;
import androidx.car.app.navigation.model.TravelEstimate;
import androidx.car.app.navigation.model.Trip;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;
import com.navapp.outdoor.israel.LocalCarServer;
import com.navapp.outdoor.israel.NativeMapStore;
import java.util.Collections;
import java.util.List;
import java.util.TimeZone;

/**
 * Shared Android Auto Car App Session owning the offline map surface controller,
 * 1Hz GNSS location tracker, route/POI synchronization listener, and Car NavigationManager.
 */
public final class NavCarSession extends Session
    implements NativeMapStore.CarStateListener, CarNavLocationTracker.Listener {

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private NativeMapStore store;
    private CarMapController mapController;
    private CarNavLocationTracker locationTracker;
    private NavigationManager navigationManager;
    private NavCarMapScreen rootMapScreen;

    private NativeMapStore.CarSyncState syncState = new NativeMapStore.CarSyncState();
    private NativeMapStore.CarRoute activeRoute = null;
    private List<NativeMapStore.CarRoute> savedRoutes = Collections.emptyList();
    private NativeMapStore.CarPoi targetPoi = null;
    private boolean carLocalNavRequested = false;
    private boolean hostNavigationStarted = false;
    private long lastTripUpdateElapsedMs = 0L;
    private long lastUiInvalidateElapsedMs = 0L;

    @NonNull
    @Override
    public Screen onCreateScreen(@NonNull Intent intent) {
        CarContext ctx = getCarContext();
        this.store = NativeMapStore.getInstance(ctx);
        LocalCarServer.getInstance(ctx).ensureStarted();
        this.store.ensurePoisLoadedAsync();

        this.mapController = new CarMapController(ctx);
        this.mapController.setStateChangedHook(() -> mainHandler.post(this::invalidateTopScreen));

        this.locationTracker = new CarNavLocationTracker(ctx, this);
        this.navigationManager = ctx.getCarService(NavigationManager.class);

        this.navigationManager.setNavigationManagerCallback(
            new NavigationManagerCallback() {
                @Override
                public void onStopNavigation() {
                    mainHandler.post(() -> handleStopNavigationFromHostOrUser(false));
                }

                @Override
                public void onAutoDriveEnabled() {
                    // Emulated head unit auto-drive signal
                }
            }
        );

        ctx.getCarService(AppManager.class).setSurfaceCallback(mapController);
        this.store.addListener(this);

        getLifecycle().addObserver(
            new DefaultLifecycleObserver() {
                @Override
                public void onResume(@NonNull LifecycleOwner owner) {
                    locationTracker.retryStartIfPermitted();
                    reloadFromStore(false);
                }

                @Override
                public void onDestroy(@NonNull LifecycleOwner owner) {
                    store.removeListener(NavCarSession.this);
                    locationTracker.stop();
                    endHostNavigationIfNeeded();
                    CarNavigationForegroundService.stop(ctx);
                    mapController.destroy();
                }
            }
        );

        this.locationTracker.start();
        this.rootMapScreen = new NavCarMapScreen(ctx, this);
        reloadFromStore(true);
        return this.rootMapScreen;
    }

    @Override
    public void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        reloadFromStore(false);
    }

    @Override
    public void onCarConfigurationChanged(@NonNull Configuration newConfiguration) {
        super.onCarConfigurationChanged(newConfiguration);
        invalidateTopScreen();
    }

    public NativeMapStore getStore() {
        return store;
    }

    public CarMapController getMapController() {
        return mapController;
    }

    public NativeMapStore.CarSyncState getSyncState() {
        return syncState;
    }

    public NativeMapStore.CarRoute getActiveRoute() {
        return activeRoute;
    }

    public List<NativeMapStore.CarRoute> getSavedRoutes() {
        return savedRoutes;
    }

    public NativeMapStore.CarPoi getTargetPoi() {
        return targetPoi;
    }

    public CarNavLocationTracker.NavTelemetry getLatestTelemetry() {
        return locationTracker != null ? locationTracker.getLastTelemetry() : null;
    }

    public boolean isNavigating() {
        boolean phoneNavActive = syncState != null && syncState.isNavigationActive;
        return (carLocalNavRequested || phoneNavActive) && (activeRoute != null || targetPoi != null);
    }

    public void selectRouteAndNavigate(NativeMapStore.CarRoute route) {
        if (route == null) return;
        this.targetPoi = null;
        this.activeRoute = route;
        this.carLocalNavRequested = true;
        store.saveActiveRouteFromCar(route);
        store.setNavigationActiveFromCar(true);
        mapController.focusOnRoute(route);
        syncNavigationTargetsAndHost(true);
        popToMapAndInvalidate();
    }

    public void selectPoiAndNavigate(NativeMapStore.CarPoi poi) {
        if (poi == null) return;
        this.targetPoi = poi;
        this.carLocalNavRequested = true;
        store.setNavigationActiveFromCar(true);
        mapController.focusOnPoi(poi);
        syncNavigationTargetsAndHost(true);
        popToMapAndInvalidate();
    }

    public void stopNavigation() {
        handleStopNavigationFromHostOrUser(true);
    }

    public String cycleVisualMode() {
        NativeMapStore.CarSyncState next = store.loadCarState();
        String label;
        if (!next.visibility.googleSatellite && "topo-day".equals(next.theme)) {
            next.theme = "topo-dark";
            label = "מפה טופוגרפית — לילה";
        } else if (!next.visibility.googleSatellite && "topo-dark".equals(next.theme)) {
            next.visibility.googleSatellite = true;
            label = "תצלום אוויר לוויין + שבילים";
        } else {
            next.visibility.googleSatellite = false;
            next.theme = "topo-day";
            label = "מפה טופוגרפית — יום";
        }
        store.saveCarStateFromCar(next);
        reloadFromStore(true);
        return label;
    }

    @Override
    public void onCarStateUpdated() {
        mainHandler.post(() -> reloadFromStore(false));
    }

    @Override
    public void onArchiveUpdated(String fileName) {
        mainHandler.post(() -> reloadFromStore(true));
    }

    @Override
    public void onTelemetryChanged(CarNavLocationTracker.NavTelemetry telemetry) {
        mainHandler.post(() -> {
            mapController.updateTelemetry(telemetry);
            updateTripOnHost(telemetry, false);
            long now = SystemClock.elapsedRealtime();
            if (now - lastUiInvalidateElapsedMs >= 1000L) {
                lastUiInvalidateElapsedMs = now;
                if (rootMapScreen != null) {
                    Screen top = getCarContext().getCarService(ScreenManager.class).getTop();
                    if (top == rootMapScreen) {
                        rootMapScreen.invalidate();
                    }
                }
            }
        });
    }

    private void reloadFromStore(boolean forceStyleReload) {
        this.syncState = store.loadCarState();
        this.activeRoute = store.loadActiveRoute();
        this.savedRoutes = store.loadSavedRoutes();
        if (this.syncState.isNavigationActive && (this.activeRoute != null || this.targetPoi != null)) {
            this.carLocalNavRequested = true;
        }
        mapController.updateSyncedData(syncState, activeRoute, savedRoutes, targetPoi, forceStyleReload);
        syncNavigationTargetsAndHost(false);
        invalidateTopScreen();
    }

    private void syncNavigationTargetsAndHost(boolean forceTripUpdate) {
        if (locationTracker != null) {
            locationTracker.setActiveTargets(activeRoute, targetPoi);
        }
        if (isNavigating()) {
            if (!hostNavigationStarted) {
                try {
                    navigationManager.navigationStarted();
                    hostNavigationStarted = true;
                } catch (Exception ignored) {
                }
            }
            boolean hasLocationPerm = locationTracker != null && locationTracker.hasLocationPermission();
            if (hasLocationPerm) {
                CarNavLocationTracker.NavTelemetry t = getLatestTelemetry();
                String destTitle = t != null && !t.destinationName.isEmpty()
                    ? t.destinationName
                    : (targetPoi != null ? targetPoi.nameHe : (activeRoute != null ? activeRoute.name : "NavApp ניווט שטח"));
                String sub = t != null && t.isOffRoute
                    ? "סטייה מהמסלול (" + Math.round(t.crossTrackMeters) + " מ׳)"
                    : "מעקב GPS פעיל";
                CarNavigationForegroundService.startOrUpdate(getCarContext(), destTitle, sub);
                if (t != null) {
                    updateTripOnHost(t, forceTripUpdate);
                }
            } else {
                CarNavigationForegroundService.stop(getCarContext());
            }
        } else {
            endHostNavigationIfNeeded();
            CarNavigationForegroundService.stop(getCarContext());
        }
    }

    private void handleStopNavigationFromHostOrUser(boolean notifyStore) {
        this.carLocalNavRequested = false;
        this.targetPoi = null;
        if (notifyStore) {
            store.setNavigationActiveFromCar(false);
        }
        endHostNavigationIfNeeded();
        CarNavigationForegroundService.stop(getCarContext());
        mapController.updateSyncedData(syncState, activeRoute, savedRoutes, null, false);
        mapController.recenter();
        if (locationTracker != null) {
            locationTracker.setActiveTargets(activeRoute, null);
        }
        invalidateTopScreen();
    }

    private void endHostNavigationIfNeeded() {
        if (hostNavigationStarted) {
            hostNavigationStarted = false;
            try {
                navigationManager.navigationEnded();
            } catch (Exception ignored) {
            }
        }
    }

    private void updateTripOnHost(CarNavLocationTracker.NavTelemetry t, boolean force) {
        if (!hostNavigationStarted || t == null || !t.hasActiveRoute) return;
        long now = SystemClock.elapsedRealtime();
        if (!force && now - lastTripUpdateElapsedMs < 2000L) return;
        lastTripUpdateElapsedMs = now;

        try {
            Distance remDist = formatCarDistance(t.remainingDistanceMeters);
            long etaSec = Math.max(0L, t.etaSeconds);
            long arrivalMs = System.currentTimeMillis() + (etaSec * 1000L);
            TravelEstimate destEstimate = new TravelEstimate.Builder(
                remDist,
                DateTimeWithZone.create(arrivalMs, TimeZone.getDefault())
            )
                .setRemainingTimeSeconds(etaSec)
                .build();

            Destination dest = new Destination.Builder()
                .setName(t.destinationName.isEmpty() ? "יעד בשטח" : t.destinationName)
                .build();

            Maneuver maneuver = new Maneuver.Builder(t.nextManeuverType).build();
            Step step = new Step.Builder(t.nextStepCue.isEmpty() ? "המשך על הציר" : t.nextStepCue)
                .setManeuver(maneuver)
                .build();
            Distance stepDist = formatCarDistance(t.nextManeuverDistanceMeters);
            long stepEtaSec = Math.max(0L, Math.round(t.nextManeuverDistanceMeters / 6.94));
            TravelEstimate stepEstimate = new TravelEstimate.Builder(
                stepDist,
                DateTimeWithZone.create(System.currentTimeMillis() + stepEtaSec * 1000L, TimeZone.getDefault())
            )
                .setRemainingTimeSeconds(stepEtaSec)
                .build();

            Trip trip = new Trip.Builder()
                .addDestination(dest, destEstimate)
                .addStep(step, stepEstimate)
                .setCurrentRoad(t.destinationName.isEmpty() ? "שביל שטח" : t.destinationName)
                .build();

            navigationManager.updateTrip(trip);
        } catch (Exception ignored) {
            // Host might not expect trip update if session just tore down
        }
    }

    public static Distance formatCarDistance(double meters) {
        double safe = Math.max(0.0, meters);
        if (safe < 1000.0) {
            return Distance.create(Math.round(safe / 10.0) * 10.0, Distance.UNIT_METERS);
        }
        double km = Math.round((safe / 1000.0) * 10.0) / 10.0;
        return Distance.create(km, Distance.UNIT_KILOMETERS_P1);
    }

    private void popToMapAndInvalidate() {
        try {
            getCarContext().getCarService(ScreenManager.class).popToRoot();
        } catch (Exception ignored) {
        }
        invalidateTopScreen();
    }

    private void invalidateTopScreen() {
        try {
            ScreenManager sm = getCarContext().getCarService(ScreenManager.class);
            if (sm != null && sm.getTop() != null) {
                sm.getTop().invalidate();
            }
        } catch (Exception ignored) {
        }
    }
}
