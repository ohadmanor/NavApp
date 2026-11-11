package com.navapp.outdoor.israel.car;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Looper;
import android.os.SystemClock;
import androidx.annotation.NonNull;
import androidx.car.app.navigation.model.Maneuver;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationListenerCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.Granularity;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.navapp.outdoor.israel.NativeMapStore;
import java.util.List;

/**
 * Unbatched 1Hz GNSS location tracker + offline trail-matching telemetry engine
 * (cross-track off-route distance, remaining distance, upcoming turn maneuver & ETA).
 */
public final class CarNavLocationTracker {
    public static final double DEFAULT_ISRAEL_LON = 34.7818;
    public static final double DEFAULT_ISRAEL_LAT = 32.0853;
    private static final double OFF_ROUTE_THRESHOLD_METERS = 50.0;
    private static final double DEFAULT_OFFROAD_SPEED_MPS = 6.94; // ~25 km/h

    public interface Listener {
        void onTelemetryChanged(NavTelemetry telemetry);
    }

    public static final class NavTelemetry {
        public final boolean hasLocationPermission;
        public final boolean hasFix;
        public final double lon;
        public final double lat;
        public final float bearingDeg;
        public final float speedMps;
        public final float accuracyMeters;
        public final boolean hasActiveRoute;
        public final String destinationName;
        public final double remainingDistanceMeters;
        public final double crossTrackMeters;
        public final boolean isOffRoute;
        public final long etaSeconds;
        public final int nextManeuverType;
        public final double nextManeuverDistanceMeters;
        public final String nextStepCue;

        NavTelemetry(
            boolean hasLocationPermission,
            boolean hasFix,
            double lon,
            double lat,
            float bearingDeg,
            float speedMps,
            float accuracyMeters,
            boolean hasActiveRoute,
            String destinationName,
            double remainingDistanceMeters,
            double crossTrackMeters,
            boolean isOffRoute,
            long etaSeconds,
            int nextManeuverType,
            double nextManeuverDistanceMeters,
            String nextStepCue
        ) {
            this.hasLocationPermission = hasLocationPermission;
            this.hasFix = hasFix;
            this.lon = lon;
            this.lat = lat;
            this.bearingDeg = bearingDeg;
            this.speedMps = speedMps;
            this.accuracyMeters = accuracyMeters;
            this.hasActiveRoute = hasActiveRoute;
            this.destinationName = destinationName;
            this.remainingDistanceMeters = remainingDistanceMeters;
            this.crossTrackMeters = crossTrackMeters;
            this.isOffRoute = isOffRoute;
            this.etaSeconds = etaSeconds;
            this.nextManeuverType = nextManeuverType;
            this.nextManeuverDistanceMeters = nextManeuverDistanceMeters;
            this.nextStepCue = nextStepCue;
        }
    }

    private final Context appContext;
    private final Listener listener;
    private final FusedLocationProviderClient fusedClient;
    private final LocationManager locationManager;

    private LocationCallback fusedCallback;
    private LocationListener gpsListener;
    private boolean started = false;
    private long lastFusedElapsedNs = 0L;

    private double currentLon = DEFAULT_ISRAEL_LON;
    private double currentLat = DEFAULT_ISRAEL_LAT;
    private float currentBearing = 0f;
    private float currentSpeed = 0f;
    private float currentAccuracy = 0f;
    private boolean hasFix = false;

    private NativeMapStore.CarRoute activeRoute;
    private NativeMapStore.CarPoi targetPoi;
    private NavTelemetry lastTelemetry;

    public CarNavLocationTracker(Context context, Listener listener) {
        this.appContext = context.getApplicationContext();
        this.listener = listener;
        this.fusedClient = LocationServices.getFusedLocationProviderClient(this.appContext);
        this.locationManager = (LocationManager) this.appContext.getSystemService(Context.LOCATION_SERVICE);
        this.lastTelemetry = computeTelemetry();
    }

    public boolean hasLocationPermission() {
        boolean fine = ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
        boolean coarse = ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_COARSE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
        return fine || coarse;
    }

    public void setActiveTargets(NativeMapStore.CarRoute route, NativeMapStore.CarPoi poi) {
        this.activeRoute = route;
        this.targetPoi = poi;
        emitTelemetry();
    }

    public NavTelemetry getLastTelemetry() {
        return lastTelemetry;
    }

    @SuppressLint("MissingPermission")
    public void start() {
        if (started) return;
        if (!hasLocationPermission()) {
            emitTelemetry();
            return;
        }
        started = true;

        try {
            fusedClient.getLastLocation().addOnSuccessListener(loc -> {
                if (loc != null && !hasFix) {
                    applyLocation(loc);
                }
            });
        } catch (Exception ignored) {
        }

        try {
            LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L)
                .setMinUpdateIntervalMillis(500L)
                .setMaxUpdateDelayMillis(0L)
                .setGranularity(Granularity.GRANULARITY_FINE)
                .setWaitForAccurateLocation(false)
                .build();

            fusedCallback = new LocationCallback() {
                @Override
                public void onLocationResult(@NonNull LocationResult locationResult) {
                    Location latest = locationResult.getLastLocation();
                    if (latest != null) {
                        lastFusedElapsedNs = SystemClock.elapsedRealtimeNanos();
                        applyLocation(latest);
                    }
                }
            };
            fusedClient.requestLocationUpdates(req, fusedCallback, Looper.getMainLooper());
        } catch (Exception ignored) {
        }

        if (locationManager != null
            && ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED) {
            gpsListener = (LocationListenerCompat) loc -> {
                long silenceNs = SystemClock.elapsedRealtimeNanos() - lastFusedElapsedNs;
                if (lastFusedElapsedNs == 0L || silenceNs > 2_000_000_000L) {
                    applyLocation(loc);
                }
            };
            try {
                if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    locationManager.requestLocationUpdates(
                        LocationManager.GPS_PROVIDER,
                        1000L,
                        0f,
                        gpsListener,
                        Looper.getMainLooper()
                    );
                }
            } catch (Exception ignored) {
            }
        }
    }

    public void retryStartIfPermitted() {
        if (!started && hasLocationPermission()) {
            start();
        } else {
            emitTelemetry();
        }
    }

    public void stop() {
        started = false;
        if (fusedCallback != null) {
            try {
                fusedClient.removeLocationUpdates(fusedCallback);
            } catch (Exception ignored) {
            }
            fusedCallback = null;
        }
        if (gpsListener != null && locationManager != null) {
            try {
                locationManager.removeUpdates(gpsListener);
            } catch (Exception ignored) {
            }
            gpsListener = null;
        }
    }

    private void applyLocation(Location loc) {
        if (loc == null) return;
        double lat = loc.getLatitude();
        double lon = loc.getLongitude();
        if (Double.isNaN(lat) || Double.isNaN(lon)) return;
        this.currentLat = lat;
        this.currentLon = lon;
        if (loc.hasBearing()) {
            this.currentBearing = loc.getBearing();
        }
        this.currentSpeed = loc.hasSpeed() ? Math.max(0f, loc.getSpeed()) : 0f;
        this.currentAccuracy = loc.hasAccuracy() ? loc.getAccuracy() : 0f;
        this.hasFix = true;
        emitTelemetry();
    }

    private void emitTelemetry() {
        NavTelemetry t = computeTelemetry();
        this.lastTelemetry = t;
        if (listener != null) {
            listener.onTelemetryChanged(t);
        }
    }

    private NavTelemetry computeTelemetry() {
        boolean permitted = hasLocationPermission();
        double refLon = currentLon;
        double refLat = currentLat;

        // If a target POI is selected without an active multi-point route, navigate straight bearing
        if (targetPoi != null) {
            double distM = NativeMapStore.haversineMeters(refLat, refLon, targetPoi.lat, targetPoi.lon);
            double effectiveSpeed = currentSpeed > 1.2f ? currentSpeed : DEFAULT_OFFROAD_SPEED_MPS;
            long etaSec = Math.max(0L, Math.round(distM / effectiveSpeed));
            double targetBearing = bearingDegrees(refLat, refLon, targetPoi.lat, targetPoi.lon);
            int maneuver = (!hasFix || currentSpeed < 0.7f)
                ? Maneuver.TYPE_STRAIGHT
                : inferRelativeTurnManeuver(currentBearing, targetBearing, distM);
            String cue = distM < 45.0
                ? ("הגעת אל " + targetPoi.nameHe)
                : ("כיוון אל " + targetPoi.nameHe);
            return new NavTelemetry(
                permitted,
                hasFix,
                refLon,
                refLat,
                currentBearing,
                currentSpeed,
                currentAccuracy,
                true,
                targetPoi.nameHe,
                distM,
                0.0,
                false,
                etaSec,
                maneuver,
                distM,
                cue
            );
        }

        NativeMapStore.CarRoute route = this.activeRoute;
        if (route == null || route.flattenedPoints.isEmpty()) {
            return new NavTelemetry(
                permitted,
                hasFix,
                refLon,
                refLat,
                currentBearing,
                currentSpeed,
                currentAccuracy,
                false,
                "",
                0.0,
                0.0,
                false,
                0L,
                Maneuver.TYPE_STRAIGHT,
                0.0,
                ""
            );
        }

        List<double[]> pts = route.flattenedPoints;
        int n = pts.size();
        if (n == 1) {
            double[] only = pts.get(0);
            double distM = NativeMapStore.haversineMeters(refLat, refLon, only[1], only[0]);
            double effSpeed = currentSpeed > 1.2f ? currentSpeed : DEFAULT_OFFROAD_SPEED_MPS;
            long etaSec = Math.max(0L, Math.round(distM / effSpeed));
            return new NavTelemetry(
                permitted,
                hasFix,
                refLon,
                refLat,
                currentBearing,
                currentSpeed,
                currentAccuracy,
                true,
                route.name,
                distM,
                distM,
                distM > OFF_ROUTE_THRESHOLD_METERS,
                etaSec,
                Maneuver.TYPE_DESTINATION,
                distM,
                route.name
            );
        }

        // Project current GPS onto closest segment of route
        double bestDistM = Double.MAX_VALUE;
        int bestSegIdx = 0;
        double bestProjLon = pts.get(0)[0];
        double bestProjLat = pts.get(0)[1];
        double cosLat = Math.cos(Math.toRadians(refLat));
        double metersPerDegLat = 111320.0;
        double metersPerDegLon = Math.max(1.0, 111320.0 * cosLat);

        for (int i = 0; i < n - 1; i++) {
            double[] a = pts.get(i);
            double[] b = pts.get(i + 1);
            double ax = (a[0] - refLon) * metersPerDegLon;
            double ay = (a[1] - refLat) * metersPerDegLat;
            double bx = (b[0] - refLon) * metersPerDegLon;
            double by = (b[1] - refLat) * metersPerDegLat;
            double dx = bx - ax;
            double dy = by - ay;
            double lenSq = dx * dx + dy * dy;
            double t = lenSq > 1e-6 ? Math.max(0.0, Math.min(1.0, -(ax * dx + ay * dy) / lenSq)) : 0.0;
            double px = ax + t * dx;
            double py = ay + t * dy;
            double d = Math.hypot(px, py);
            if (d < bestDistM) {
                bestDistM = d;
                bestSegIdx = i;
                bestProjLon = a[0] + t * (b[0] - a[0]);
                bestProjLat = a[1] + t * (b[1] - a[1]);
            }
        }

        // Compute exact remaining distance from snapped projection to end of route
        double remainingM = NativeMapStore.haversineMeters(
            bestProjLat,
            bestProjLon,
            pts.get(bestSegIdx + 1)[1],
            pts.get(bestSegIdx + 1)[0]
        );
        for (int i = bestSegIdx + 1; i < n - 1; i++) {
            double[] a = pts.get(i);
            double[] b = pts.get(i + 1);
            remainingM += NativeMapStore.haversineMeters(a[1], a[0], b[1], b[0]);
        }

        boolean offRoute = hasFix && bestDistM > OFF_ROUTE_THRESHOLD_METERS;
        double effSpeed = currentSpeed > 1.2f ? currentSpeed : DEFAULT_OFFROAD_SPEED_MPS;
        long etaSec = Math.max(0L, Math.round(remainingM / effSpeed));

        // Look ahead ~60-150m along route to compute turn maneuver vs current leg bearing
        double legBearing = bearingDegrees(
            pts.get(bestSegIdx)[1],
            pts.get(bestSegIdx)[0],
            pts.get(bestSegIdx + 1)[1],
            pts.get(bestSegIdx + 1)[0]
        );
        int lookIdx = bestSegIdx + 1;
        double stepDistM = NativeMapStore.haversineMeters(
            bestProjLat,
            bestProjLon,
            pts.get(lookIdx)[1],
            pts.get(lookIdx)[0]
        );
        while (lookIdx < n - 1 && stepDistM < 60.0) {
            double[] p0 = pts.get(lookIdx);
            double[] p1 = pts.get(lookIdx + 1);
            stepDistM += NativeMapStore.haversineMeters(p0[1], p0[0], p1[1], p1[0]);
            lookIdx++;
        }

        int maneuver = Maneuver.TYPE_STRAIGHT;
        String cue = offRoute
            ? ("סטייה מהמסלול (" + Math.round(bestDistM) + " מ׳)")
            : ("המשך על " + route.name);

        if (remainingM < 60.0) {
            maneuver = Maneuver.TYPE_DESTINATION;
            stepDistM = remainingM;
            cue = offRoute ? cue : ("סיום מסלול: " + route.name);
        } else if (lookIdx < n - 1) {
            double nextBearing = bearingDegrees(
                pts.get(lookIdx - 1)[1],
                pts.get(lookIdx - 1)[0],
                pts.get(lookIdx)[1],
                pts.get(lookIdx)[0]
            );
            maneuver = inferTurnFromDelta(normalizeSignedAngle(nextBearing - legBearing));
            if (!offRoute) {
                cue = describeManeuverHe(maneuver, route.name);
            }
        }

        return new NavTelemetry(
            permitted,
            hasFix,
            refLon,
            refLat,
            currentBearing,
            currentSpeed,
            currentAccuracy,
            true,
            route.name,
            remainingM,
            bestDistM,
            offRoute,
            etaSec,
            maneuver,
            Math.max(10.0, stepDistM),
            cue
        );
    }

    private static double bearingDegrees(double lat1, double lon1, double lat2, double lon2) {
        double phi1 = Math.toRadians(lat1);
        double phi2 = Math.toRadians(lat2);
        double dLon = Math.toRadians(lon2 - lon1);
        double y = Math.sin(dLon) * Math.cos(phi2);
        double x = Math.cos(phi1) * Math.sin(phi2)
            - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
        double deg = Math.toDegrees(Math.atan2(y, x));
        return (deg + 360.0) % 360.0;
    }

    private static double normalizeSignedAngle(double deg) {
        double d = (deg + 540.0) % 360.0 - 180.0;
        return d;
    }

    private static int inferRelativeTurnManeuver(double currentHeading, double targetBearing, double distM) {
        if (distM < 45.0) return Maneuver.TYPE_DESTINATION;
        if (currentSpeedLikelyStationary(currentHeading)) {
            return Maneuver.TYPE_STRAIGHT;
        }
        return inferTurnFromDelta(normalizeSignedAngle(targetBearing - currentHeading));
    }

    private static boolean currentSpeedLikelyStationary(double bearing) {
        return Double.isNaN(bearing);
    }

    private static int inferTurnFromDelta(double deltaDeg) {
        double abs = Math.abs(deltaDeg);
        if (abs < 22.0) return Maneuver.TYPE_STRAIGHT;
        if (abs > 145.0) return deltaDeg >= 0 ? Maneuver.TYPE_U_TURN_RIGHT : Maneuver.TYPE_U_TURN_LEFT;
        if (abs >= 110.0) return deltaDeg >= 0 ? Maneuver.TYPE_TURN_SHARP_RIGHT : Maneuver.TYPE_TURN_SHARP_LEFT;
        if (abs >= 50.0) return deltaDeg >= 0 ? Maneuver.TYPE_TURN_NORMAL_RIGHT : Maneuver.TYPE_TURN_NORMAL_LEFT;
        return deltaDeg >= 0 ? Maneuver.TYPE_TURN_SLIGHT_RIGHT : Maneuver.TYPE_TURN_SLIGHT_LEFT;
    }

    private static String describeManeuverHe(int type, String fallbackRouteName) {
        switch (type) {
            case Maneuver.TYPE_TURN_SLIGHT_RIGHT:
                return "נטה ימינה על הציר";
            case Maneuver.TYPE_TURN_SLIGHT_LEFT:
                return "נטה שמאלה על הציר";
            case Maneuver.TYPE_TURN_NORMAL_RIGHT:
            case Maneuver.TYPE_TURN_SHARP_RIGHT:
                return "פנה ימינה בשטח";
            case Maneuver.TYPE_TURN_NORMAL_LEFT:
            case Maneuver.TYPE_TURN_SHARP_LEFT:
                return "פנה שמאלה בשטח";
            case Maneuver.TYPE_U_TURN_LEFT:
            case Maneuver.TYPE_U_TURN_RIGHT:
                return "בצע פניית פרסה";
            case Maneuver.TYPE_DESTINATION:
                return "מתקרב לסיום המסלול";
            default:
                return "המשך ישר • " + fallbackRouteName;
        }
    }
}
