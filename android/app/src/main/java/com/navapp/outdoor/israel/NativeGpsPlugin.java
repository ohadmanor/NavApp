package com.navapp.outdoor.israel;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Looper;
import android.os.SystemClock;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.location.LocationListenerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.location.CurrentLocationRequest;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.Granularity;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/**
 * Unbatched, high-frequency GNSS/Fused location plugin for active driving & outdoor navigation.
 *
 * Unlike @capacitor/geolocation (which maps `options.timeout` to FusedLocationProvider's
 * active update intervalMillis and coerces missing speed/bearing to 0.0f), this plugin:
 *  - Requests active 500ms-1Hz updates with maxUpdateDelayMillis = 0 (no Fused batching).
 *  - Keeps hardware LocationManager.GPS_PROVIDER warm in continuous tracking mode as fallback.
 *  - Only emits speed/heading when Location.hasSpeed() / Location.hasBearing() are true.
 *  - Reports monotonic fixAgeMs derived from SystemClock.elapsedRealtimeNanos().
 */
@CapacitorPlugin(
    name = "NativeGps",
    permissions = {
        @Permission(
            strings = {
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION
            },
            alias = NativeGpsPlugin.LOCATION_ALIAS
        ),
        @Permission(
            strings = {Manifest.permission.ACCESS_COARSE_LOCATION},
            alias = NativeGpsPlugin.COARSE_LOCATION_ALIAS
        )
    }
)
public class NativeGpsPlugin extends Plugin {
    static final String LOCATION_ALIAS = "location";
    static final String COARSE_LOCATION_ALIAS = "coarseLocation";

    private static final String ERR_PERMISSION_DENIED = "OS-PLUG-GLOC-0003";
    private static final String ERR_LOCATION_DISABLED = "OS-PLUG-GLOC-0007";
    private static final String ERR_POSITION_UNAVAILABLE = "OS-PLUG-GLOC-0002";

    private static final class WatchSession {
        final PluginCall call;
        final boolean enableHighAccuracy;
        final long intervalMs;
        FusedLocationProviderClient fusedClient;
        LocationCallback fusedCallback;
        LocationManager locationManager;
        LocationListener gpsListener;
        LocationListener networkListener;
        boolean fusedActive = false;
        long lastFusedSystemElapsedNs = 0L;
        long lastGpsSystemElapsedNs = 0L;
        long lastEmittedElapsedNs = Long.MIN_VALUE;

        WatchSession(PluginCall call, boolean enableHighAccuracy, long intervalMs) {
            this.call = call;
            this.enableHighAccuracy = enableHighAccuracy;
            this.intervalMs = intervalMs;
        }
    }

    private final Map<String, WatchSession> watches = new ConcurrentHashMap<>();

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        for (String id : new ArrayList<>(watches.keySet())) {
            WatchSession session = watches.remove(id);
            if (session != null) {
                stopWatchSession(session, true);
            }
        }
    }

    @PluginMethod
    @Override
    public void checkPermissions(PluginCall call) {
        if (!isLocationEnabled()) {
            call.reject("Location services are disabled", ERR_LOCATION_DISABLED);
            return;
        }
        super.checkPermissions(call);
    }

    @PluginMethod
    @Override
    public void requestPermissions(PluginCall call) {
        if (!isLocationEnabled()) {
            call.reject("Location services are disabled", ERR_LOCATION_DISABLED);
            return;
        }
        super.requestPermissions(call);
    }

    @PluginMethod
    public void getCurrentPosition(PluginCall call) {
        String alias = getPermissionAlias(call);
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias, call, "completeGetCurrentPosition");
            return;
        }
        performGetCurrentPosition(call);
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void watchPosition(PluginCall call) {
        String alias = getPermissionAlias(call);
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias, call, "completeWatchPosition");
            return;
        }
        startWatchSession(call);
    }

    @PluginMethod
    public void clearWatch(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.trim().isEmpty()) {
            call.reject("Watch id is required");
            return;
        }
        WatchSession session = watches.remove(id);
        if (session != null) {
            stopWatchSession(session, true);
        }
        call.resolve();
    }

    @PermissionCallback
    private void completeGetCurrentPosition(PluginCall call) {
        if (hasAnyLocationPermission()) {
            performGetCurrentPosition(call);
        } else {
            call.reject("Location permission denied", ERR_PERMISSION_DENIED);
        }
    }

    @PermissionCallback
    private void completeWatchPosition(PluginCall call) {
        if (hasAnyLocationPermission()) {
            startWatchSession(call);
        } else {
            call.reject("Location permission denied", ERR_PERMISSION_DENIED);
        }
    }

    private String getPermissionAlias(PluginCall call) {
        boolean highAccuracy = Boolean.TRUE.equals(call.getBoolean("enableHighAccuracy", true));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !highAccuracy) {
            return COARSE_LOCATION_ALIAS;
        }
        return LOCATION_ALIAS;
    }

    private boolean hasFineLocationPermission() {
        return ActivityCompat.checkSelfPermission(
            getContext(),
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasCoarseLocationPermission() {
        return ActivityCompat.checkSelfPermission(
            getContext(),
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAnyLocationPermission() {
        return getPermissionState(COARSE_LOCATION_ALIAS) == PermissionState.GRANTED
            || getPermissionState(LOCATION_ALIAS) == PermissionState.GRANTED
            || hasFineLocationPermission()
            || hasCoarseLocationPermission();
    }

    private boolean isLocationEnabled() {
        Context ctx = getContext();
        LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return lm.isLocationEnabled();
        }
        boolean gps = false;
        boolean net = false;
        try {
            gps = lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (Exception ignored) {
        }
        try {
            net = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception ignored) {
        }
        return gps || net;
    }

    @SuppressLint("MissingPermission")
    private void performGetCurrentPosition(PluginCall call) {
        if (!hasAnyLocationPermission()) {
            call.reject("Location permission denied", ERR_PERMISSION_DENIED);
            return;
        }
        if (!isLocationEnabled()) {
            call.reject("Location services are disabled", ERR_LOCATION_DISABLED);
            return;
        }

        boolean enableHighAccuracy = Boolean.TRUE.equals(call.getBoolean("enableHighAccuracy", true));
        long maximumAge = readLongOption(call, "maximumAge", 0L);
        long timeout = clampLong(readLongOption(call, "timeout", 5000L), 1000L, 30000L);
        int priority = (enableHighAccuracy && hasFineLocationPermission())
            ? Priority.PRIORITY_HIGH_ACCURACY
            : Priority.PRIORITY_BALANCED_POWER_ACCURACY;

        try {
            FusedLocationProviderClient client = LocationServices.getFusedLocationProviderClient(getContext());
            CurrentLocationRequest req = new CurrentLocationRequest.Builder()
                .setPriority(priority)
                .setGranularity(Granularity.GRANULARITY_FINE)
                .setMaxUpdateAgeMillis(Math.max(0L, maximumAge))
                .setDurationMillis(timeout)
                .build();
            CancellationTokenSource cts = new CancellationTokenSource();
            client.getCurrentLocation(req, cts.getToken())
                .addOnSuccessListener(location -> {
                    if (location != null) {
                        call.resolve(toJsLocation(location));
                    } else {
                        resolveFromLocationManagerLastKnown(call);
                    }
                })
                .addOnFailureListener(err -> resolveFromLocationManagerLastKnown(call));
        } catch (Exception ex) {
            resolveFromLocationManagerLastKnown(call);
        }
    }

    @SuppressLint("MissingPermission")
    private void resolveFromLocationManagerLastKnown(PluginCall call) {
        try {
            LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            if (lm != null) {
                Location best = null;
                if (hasFineLocationPermission()) {
                    try {
                        best = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                    } catch (Exception ignored) {
                    }
                }
                try {
                    Location net = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                    if (net != null && (best == null || net.getElapsedRealtimeNanos() > best.getElapsedRealtimeNanos())) {
                        best = net;
                    }
                } catch (Exception ignored) {
                }
                if (best != null) {
                    call.resolve(toJsLocation(best));
                    return;
                }
            }
        } catch (Exception ignored) {
        }
        call.reject("Location unavailable", ERR_POSITION_UNAVAILABLE);
    }

    @SuppressLint("MissingPermission")
    private void startWatchSession(PluginCall call) {
        if (!hasAnyLocationPermission()) {
            call.reject("Location permission denied", ERR_PERMISSION_DENIED);
            return;
        }
        if (!isLocationEnabled()) {
            call.reject("Location services are disabled", ERR_LOCATION_DISABLED);
            return;
        }

        boolean requestedHighAccuracy = Boolean.TRUE.equals(call.getBoolean("enableHighAccuracy", true));
        boolean highAccuracy = requestedHighAccuracy && hasFineLocationPermission();
        long minIntervalOpt = readLongOption(call, "minimumUpdateInterval", 500L);
        long intervalMs = clampLong(minIntervalOpt, 250L, 5000L);

        call.setKeepAlive(true);
        String watchId = call.getCallbackId();
        WatchSession existing = watches.remove(watchId);
        if (existing != null) {
            stopWatchSession(existing, false);
        }

        WatchSession session = new WatchSession(call, highAccuracy, intervalMs);
        watches.put(watchId, session);

        // 1. Primary: unbatched high-accuracy FusedLocationProviderClient
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        session.locationManager = lm;

        try {
            FusedLocationProviderClient fusedClient =
                LocationServices.getFusedLocationProviderClient(getContext());
            session.fusedClient = fusedClient;

            LocationRequest fusedReq = new LocationRequest.Builder(
                highAccuracy ? Priority.PRIORITY_HIGH_ACCURACY : Priority.PRIORITY_BALANCED_POWER_ACCURACY,
                intervalMs
            )
                .setMinUpdateIntervalMillis(Math.max(250L, intervalMs / 2L))
                .setMaxUpdateDelayMillis(0L)
                .setMaxUpdateAgeMillis(0L)
                .setMinUpdateDistanceMeters(0f)
                .setWaitForAccurateLocation(false)
                .setGranularity(highAccuracy ? Granularity.GRANULARITY_FINE : Granularity.GRANULARITY_COARSE)
                .build();

            session.fusedCallback = new LocationCallback() {
                @Override
                public void onLocationResult(@NonNull LocationResult locationResult) {
                    if (watches.get(watchId) != session) return;
                    List<Location> list = locationResult.getLocations();
                    if (list.isEmpty()) return;

                    List<Location> ordered = list.size() > 1 ? new ArrayList<>(list) : list;
                    if (ordered.size() > 1) {
                        Collections.sort(
                            ordered,
                            Comparator.comparingLong(Location::getElapsedRealtimeNanos)
                        );
                    }

                    long nowSystemNs = SystemClock.elapsedRealtimeNanos();
                    for (Location loc : ordered) {
                        if (loc == null || !isValidCoordinate(loc)) continue;
                        long locElapsedNs = loc.getElapsedRealtimeNanos();
                        if (locElapsedNs > session.lastEmittedElapsedNs + 80_000_000L) {
                            session.lastFusedSystemElapsedNs = nowSystemNs;
                            session.lastEmittedElapsedNs = locElapsedNs;
                            session.call.resolve(toJsLocation(loc));
                        }
                    }
                }
            };

            fusedClient.requestLocationUpdates(fusedReq, session.fusedCallback, Looper.getMainLooper())
                .addOnSuccessListener(unused -> session.fusedActive = true)
                .addOnFailureListener(err -> {
                    session.fusedActive = false;
                    if (watches.get(watchId) == session) {
                        attachNetworkFallback(watchId, session);
                    }
                });
            session.fusedActive = true;
        } catch (Exception ex) {
            session.fusedActive = false;
        }

        // 2. Hardware GNSS keeper & zero-stall fallback via LocationManager.GPS_PROVIDER
        if (lm != null) {
            if (highAccuracy && hasFineLocationPermission()) {
                session.gpsListener = (LocationListenerCompat) loc -> {
                    if (watches.get(watchId) != session || !isValidCoordinate(loc)) return;
                    long nowSystemNs = SystemClock.elapsedRealtimeNanos();
                    session.lastGpsSystemElapsedNs = nowSystemNs;
                    long fusedSilenceNs = nowSystemNs - session.lastFusedSystemElapsedNs;
                    long stallThresholdNs = Math.max(1_200_000_000L, session.intervalMs * 2_000_000L);
                    boolean fusedUnavailableOrStalled =
                        !session.fusedActive
                            || session.lastFusedSystemElapsedNs == 0L
                            || fusedSilenceNs > stallThresholdNs;
                    if (fusedUnavailableOrStalled
                        && loc.getElapsedRealtimeNanos() > session.lastEmittedElapsedNs + 120_000_000L) {
                        session.lastEmittedElapsedNs = loc.getElapsedRealtimeNanos();
                        session.call.resolve(toJsLocation(loc));
                    }
                };

                try {
                    if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                        lm.requestLocationUpdates(
                            LocationManager.GPS_PROVIDER,
                            intervalMs,
                            0f,
                            session.gpsListener,
                            Looper.getMainLooper()
                        );
                    }
                } catch (Exception ignored) {
                }
            }

            if (!session.fusedActive) {
                attachNetworkFallback(watchId, session);
            }
        }
    }

    @SuppressLint("MissingPermission")
    private void attachNetworkFallback(String watchId, WatchSession session) {
        LocationManager lm = session.locationManager;
        if (lm == null || session.networkListener != null) return;
        session.networkListener = (LocationListenerCompat) loc -> {
            if (watches.get(watchId) != session || !isValidCoordinate(loc)) return;
            long nowSystemNs = SystemClock.elapsedRealtimeNanos();
            boolean fusedFresh =
                session.fusedActive && nowSystemNs - session.lastFusedSystemElapsedNs <= 3_000_000_000L;
            boolean gpsFresh =
                session.lastGpsSystemElapsedNs > 0L && nowSystemNs - session.lastGpsSystemElapsedNs <= 3_000_000_000L;
            if (!fusedFresh
                && !gpsFresh
                && loc.getElapsedRealtimeNanos() > session.lastEmittedElapsedNs + 200_000_000L) {
                session.lastEmittedElapsedNs = loc.getElapsedRealtimeNanos();
                session.call.resolve(toJsLocation(loc));
            }
        };
        try {
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    Math.max(1000L, session.intervalMs),
                    0f,
                    session.networkListener,
                    Looper.getMainLooper()
                );
            }
        } catch (Exception ignored) {
        }
    }

    @SuppressLint("MissingPermission")
    private void stopWatchSession(WatchSession session, boolean releaseCall) {
        if (session.fusedClient != null && session.fusedCallback != null) {
            try {
                session.fusedClient.removeLocationUpdates(session.fusedCallback);
            } catch (Exception ignored) {
            }
        }
        if (session.locationManager != null) {
            if (session.gpsListener != null) {
                try {
                    session.locationManager.removeUpdates(session.gpsListener);
                } catch (Exception ignored) {
                }
            }
            if (session.networkListener != null) {
                try {
                    session.locationManager.removeUpdates(session.networkListener);
                } catch (Exception ignored) {
                }
            }
        }
        if (releaseCall && session.call != null && getBridge() != null) {
            try {
                session.call.release(getBridge());
            } catch (Exception ignored) {
            }
        }
    }

    private JSObject toJsLocation(Location loc) {
        JSObject coords = new JSObject();
        coords.put("latitude", loc.getLatitude());
        coords.put("longitude", loc.getLongitude());
        coords.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : JSONObject.NULL);
        coords.put("altitude", loc.hasAltitude() ? loc.getAltitude() : JSONObject.NULL);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && loc.hasVerticalAccuracy()) {
            coords.put("altitudeAccuracy", loc.getVerticalAccuracyMeters());
        } else {
            coords.put("altitudeAccuracy", JSONObject.NULL);
        }
        // Only pass speed/heading when natively reported (never synthesize 0.0f North!)
        coords.put("speed", loc.hasSpeed() ? loc.getSpeed() : JSONObject.NULL);
        coords.put("heading", loc.hasBearing() ? loc.getBearing() : JSONObject.NULL);

        long fixAgeMs = Math.max(
            0L,
            (SystemClock.elapsedRealtimeNanos() - loc.getElapsedRealtimeNanos()) / 1_000_000L
        );

        JSObject out = new JSObject();
        out.put("timestamp", loc.getTime());
        out.put("fixAgeMs", fixAgeMs);
        out.put("coords", coords);
        return out;
    }

    private static boolean isValidCoordinate(Location loc) {
        double lat = loc.getLatitude();
        double lon = loc.getLongitude();
        return !Double.isNaN(lat) && !Double.isInfinite(lat)
            && !Double.isNaN(lon) && !Double.isInfinite(lon);
    }

    private static long readLongOption(PluginCall call, String key, long fallback) {
        Long asLong = call.getLong(key);
        if (asLong != null) return asLong;
        Integer asInt = call.getInt(key);
        if (asInt != null) return asInt.longValue();
        return fallback;
    }

    private static long clampLong(long value, long min, long max) {
        return Math.max(min, Math.min(max, value));
    }
}
