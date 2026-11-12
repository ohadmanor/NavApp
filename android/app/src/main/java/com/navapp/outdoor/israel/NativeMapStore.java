package com.navapp.outdoor.israel;

import android.content.Context;
import android.os.StatFs;
import android.util.JsonReader;
import android.util.JsonToken;
import android.util.Log;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Thread-safe singleton store sharing offline PMTiles archives, synced routes,
 * user/community POIs, and navigation display state between the Capacitor WebView
 * phone app and the Android Auto CarAppService.
 */
public final class NativeMapStore {
    private static final String TAG = "NativeMapStore";

    public static final String FILE_OSM_PMTILES = "Israel.osm.pmtiles";
    public static final String FILE_DEM_PMTILES = "Israel.dem.pmtiles";

    private static final String MAPS_DIR_NAME = "maps";
    private static final String CAR_SYNC_DIR_NAME = "car_sync";

    private static final String FILE_ACTIVE_ROUTE = "active_route.json";
    private static final String FILE_SAVED_ROUTES = "saved_routes.json";
    private static final String FILE_USER_POIS = "user_pois.json";
    private static final String FILE_DELETED_POI_IDS = "deleted_poi_ids.json";
    private static final String FILE_CAR_STATE = "car_state.json";
    private static final String FILE_COMPACT_POIS_GEOJSON = "compact_pois.geojson";

    private static final String REMOTE_DATA_ORIGIN = "https://navapp-israel-topo-data.web.app";

    public interface CarStateListener {
        void onCarStateUpdated();
        void onArchiveUpdated(String fileName);
    }

    public static final class CarRoute {
        public final String id;
        public final String name;
        public final String sourceFormat;
        public final double distanceKm;
        public final int ascentMeters;
        public final int descentMeters;
        public final String color;
        public final boolean visible;
        public final String geoJsonString;
        public final List<double[]> flattenedPoints; // [lon, lat]

        CarRoute(
            String id,
            String name,
            String sourceFormat,
            double distanceKm,
            int ascentMeters,
            int descentMeters,
            String color,
            boolean visible,
            String geoJsonString,
            List<double[]> flattenedPoints
        ) {
            this.id = id;
            this.name = name;
            this.sourceFormat = sourceFormat;
            this.distanceKm = distanceKm;
            this.ascentMeters = ascentMeters;
            this.descentMeters = descentMeters;
            this.color = color;
            this.visible = visible;
            this.geoJsonString = geoJsonString;
            this.flattenedPoints = flattenedPoints;
        }

        public double[] getStartCoord() {
            return flattenedPoints.isEmpty() ? null : flattenedPoints.get(0);
        }

        public double[] getEndCoord() {
            return flattenedPoints.isEmpty() ? null : flattenedPoints.get(flattenedPoints.size() - 1);
        }
    }

    public static final class CarPoi {
        public final String id;
        public final String nameHe;
        public final String nameEn;
        public final String category;
        public final String subcategory;
        public final double lon;
        public final double lat;
        public final Integer ele;
        public final String snippet;
        public final int priority;

        CarPoi(
            String id,
            String nameHe,
            String nameEn,
            String category,
            String subcategory,
            double lon,
            double lat,
            Integer ele,
            String snippet,
            int priority
        ) {
            this.id = id;
            this.nameHe = nameHe;
            this.nameEn = nameEn;
            this.category = category;
            this.subcategory = subcategory;
            this.lon = lon;
            this.lat = lat;
            this.ele = ele;
            this.snippet = snippet;
            this.priority = priority;
        }
    }

    public static final class CarVisibility {
        public boolean googleSatellite = false;
        public boolean hillshade = true;
        public boolean hikingTrails = true;
        public boolean offroad4x4 = true;
        public boolean pois = true;
        public boolean poiWater = true;
        public boolean poiHeritage = true;
        public boolean poiCampsites = true;
        public boolean poiOffroad = true;
        public boolean poiPeaks = true;
        public boolean poiUser = true;
    }

    public static final class CarSyncState {
        public boolean isNavigationActive = false;
        public String theme = "topo-day";
        public final CarVisibility visibility = new CarVisibility();
        public String updatedAt = "";
    }

    private static volatile NativeMapStore instance;

    private final Context appContext;
    private final File mapsDir;
    private final File carSyncDir;
    private final Set<CarStateListener> listeners = new CopyOnWriteArraySet<>();
    private final Set<String> activeDownloads = ConcurrentHashMap.newKeySet();
    private final ExecutorService poiLoaderExecutor = Executors.newSingleThreadExecutor();
    private final AtomicLong poiRevision = new AtomicLong(0);
    private final AtomicBoolean basePoisLoaded = new AtomicBoolean(false);
    private final AtomicBoolean offroadPoisLoaded = new AtomicBoolean(false);
    private final Object stateLock = new Object();

    private volatile List<CarPoi> bundledCorePois = Collections.emptyList();
    private volatile List<CarPoi> offroadPois = Collections.emptyList();
    private volatile List<CarPoi> userPois = Collections.emptyList();
    private volatile Set<String> deletedPoiIds = Collections.emptySet();
    private volatile boolean compactGeoJsonBuilt = false;

    private NativeMapStore(Context context) {
        this.appContext = context.getApplicationContext();
        this.mapsDir = new File(this.appContext.getFilesDir(), MAPS_DIR_NAME);
        this.carSyncDir = new File(this.appContext.getFilesDir(), CAR_SYNC_DIR_NAME);
        if (!this.mapsDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            this.mapsDir.mkdirs();
        }
        if (!this.carSyncDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            this.carSyncDir.mkdirs();
        }
    }

    public static NativeMapStore getInstance(Context context) {
        if (instance == null) {
            synchronized (NativeMapStore.class) {
                if (instance == null) {
                    instance = new NativeMapStore(context);
                }
            }
        }
        return instance;
    }

    public Context getAppContext() {
        return appContext;
    }

    public File getMapsDir() {
        return mapsDir;
    }

    public File getCarSyncDir() {
        return carSyncDir;
    }

    public void addListener(CarStateListener listener) {
        if (listener != null) {
            listeners.add(listener);
        }
    }

    public void removeListener(CarStateListener listener) {
        if (listener != null) {
            listeners.remove(listener);
        }
    }

    public void notifyStateUpdated() {
        for (CarStateListener listener : listeners) {
            try {
                listener.onCarStateUpdated();
            } catch (Exception ex) {
                Log.w(TAG, "Listener notification error", ex);
            }
        }
    }

    public void notifyArchiveUpdated(String fileName) {
        for (CarStateListener listener : listeners) {
            try {
                listener.onArchiveUpdated(fileName);
            } catch (Exception ex) {
                Log.w(TAG, "Archive listener notification error", ex);
            }
        }
    }

    public void markDownloadActive(String fileName, boolean active) {
        if (fileName == null) return;
        if (active) activeDownloads.add(fileName);
        else activeDownloads.remove(fileName);
    }

    public boolean isDownloadActive(String fileName) {
        return fileName != null && activeDownloads.contains(fileName);
    }

    public static String sanitizeFileName(String raw) {
        if (raw == null) return null;
        String trimmed = raw.trim();
        if (trimmed.isEmpty() || trimmed.contains("..") || trimmed.contains("/") || trimmed.contains("\\")) {
            return null;
        }
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            boolean ok =
                (c >= 'a' && c <= 'z') ||
                (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') ||
                c == '.' ||
                c == '_' ||
                c == '-';
            if (!ok) return null;
        }
        return trimmed;
    }

    public File getMapFile(String fileName) {
        String safe = sanitizeFileName(fileName);
        if (safe == null) return null;
        return new File(mapsDir, safe);
    }

    public File getValidMapFile(String fileName) {
        File file = getMapFile(fileName);
        return isValidPmTiles(file) ? file : null;
    }

    public static boolean isValidPmTiles(File file) {
        if (file == null || !file.exists() || !file.isFile() || file.length() < 127L) {
            return false;
        }
        byte[] magic = new byte[8];
        try (FileInputStream fis = new FileInputStream(file)) {
            int n = fis.read(magic);
            if (n < 8) return false;
            return magic[0] == 'P'
                && magic[1] == 'M'
                && magic[2] == 'T'
                && magic[3] == 'i'
                && magic[4] == 'l'
                && magic[5] == 'e'
                && magic[6] == 's';
        } catch (IOException ex) {
            return false;
        }
    }

    public String getMapLibreOsmUrl() {
        File local = getValidMapFile(FILE_OSM_PMTILES);
        if (local != null) {
            return "pmtiles://file://" + local.getAbsolutePath();
        }
        return "pmtiles://" + REMOTE_DATA_ORIGIN + "/data/" + FILE_OSM_PMTILES;
    }

    public String getMapLibreDemUrl() {
        File local = getValidMapFile(FILE_DEM_PMTILES);
        if (local != null) {
            return "pmtiles://file://" + local.getAbsolutePath();
        }
        return "pmtiles://" + REMOTE_DATA_ORIGIN + "/data/" + FILE_DEM_PMTILES;
    }

    public boolean hasOfflineOsm() {
        return getValidMapFile(FILE_OSM_PMTILES) != null;
    }

    public boolean hasOfflineDem() {
        return getValidMapFile(FILE_DEM_PMTILES) != null;
    }

    public long getFreeBytes() {
        try {
            StatFs statFs = new StatFs(mapsDir.getAbsolutePath());
            return statFs.getAvailableBytes();
        } catch (Exception ex) {
            return 0L;
        }
    }

    public long getTotalBytes() {
        try {
            StatFs statFs = new StatFs(mapsDir.getAbsolutePath());
            return statFs.getTotalBytes();
        } catch (Exception ex) {
            return 0L;
        }
    }

    public static String nativeUrlFor(String fileName) {
        return "https://localhost/__native_maps__/" + fileName;
    }

    public void syncCarData(
        String activeRouteJson,
        String savedRoutesJson,
        String userPoisJson,
        String carStateJson
    ) throws IOException {
        syncCarData(activeRouteJson, savedRoutesJson, userPoisJson, null, carStateJson);
    }

    public void syncCarData(
        String activeRouteJson,
        String savedRoutesJson,
        String userPoisJson,
        String deletedPoiIdsJson,
        String carStateJson
    ) throws IOException {
        synchronized (stateLock) {
            if (activeRouteJson != null) {
                writeUtf8Atomic(new File(carSyncDir, FILE_ACTIVE_ROUTE), activeRouteJson);
            }
            if (savedRoutesJson != null) {
                writeUtf8Atomic(new File(carSyncDir, FILE_SAVED_ROUTES), savedRoutesJson);
            }
            if (userPoisJson != null) {
                writeUtf8Atomic(new File(carSyncDir, FILE_USER_POIS), userPoisJson);
                reloadUserPoisLocked();
                compactGeoJsonBuilt = false;
                poiRevision.incrementAndGet();
            }
            if (deletedPoiIdsJson != null) {
                writeUtf8Atomic(new File(carSyncDir, FILE_DELETED_POI_IDS), deletedPoiIdsJson);
                reloadDeletedPoiIdsLocked();
                compactGeoJsonBuilt = false;
                poiRevision.incrementAndGet();
            }
            if (carStateJson != null) {
                writeUtf8Atomic(new File(carSyncDir, FILE_CAR_STATE), carStateJson);
            }
        }
        if (userPoisJson != null || deletedPoiIdsJson != null) {
            ensurePoisLoadedAsync();
        }
        notifyStateUpdated();
    }

    public long getPoiRevision() {
        return poiRevision.get();
    }

    public void writeUtf8Atomic(File target, String content) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        File tmp = new File(parent, target.getName() + ".tmp");
        try (FileOutputStream fos = new FileOutputStream(tmp, false)) {
            fos.write(content.getBytes(StandardCharsets.UTF_8));
            fos.getFD().sync();
        } catch (IOException ex) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw ex;
        }
        if (target.exists() && !target.delete()) {
            Log.w(TAG, "Could not remove old sync file: " + target.getName());
        }
        if (!tmp.renameTo(target)) {
            try (FileInputStream in = new FileInputStream(tmp);
                 FileOutputStream out = new FileOutputStream(target, false)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                }
            } finally {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        }
    }

    private String readUtf8OrNull(File file) {
        if (file == null || !file.exists() || !file.isFile() || file.length() > 16 * 1024 * 1024L) {
            return null;
        }
        try (FileInputStream fis = new FileInputStream(file);
             ByteArrayOutputStream bos = new ByteArrayOutputStream((int) Math.max(256, file.length()))) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = fis.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return bos.toString(StandardCharsets.UTF_8.name());
        } catch (Exception ex) {
            Log.w(TAG, "Failed reading file " + file.getName(), ex);
            return null;
        }
    }

    public CarRoute loadActiveRoute() {
        String json;
        synchronized (stateLock) {
            json = readUtf8OrNull(new File(carSyncDir, FILE_ACTIVE_ROUTE));
        }
        if (json == null || json.trim().isEmpty() || "null".equals(json.trim())) {
            return null;
        }
        try {
            return parseCarRoute(new JSONObject(json));
        } catch (Exception ex) {
            Log.w(TAG, "Failed parsing active_route.json", ex);
            return null;
        }
    }

    public void saveActiveRouteFromCar(CarRoute route) {
        try {
            if (route == null) {
                synchronized (stateLock) {
                    writeUtf8Atomic(new File(carSyncDir, FILE_ACTIVE_ROUTE), "null");
                }
            } else {
                JSONObject obj = new JSONObject();
                obj.put("id", route.id);
                obj.put("name", route.name);
                obj.put("sourceFormat", route.sourceFormat);
                obj.put("distanceKm", route.distanceKm);
                obj.put("ascentMeters", route.ascentMeters);
                obj.put("descentMeters", route.descentMeters);
                obj.put("color", route.color);
                obj.put("visible", route.visible);
                obj.put("geojson", new JSONObject(route.geoJsonString));
                synchronized (stateLock) {
                    writeUtf8Atomic(new File(carSyncDir, FILE_ACTIVE_ROUTE), obj.toString());
                }
            }
            notifyStateUpdated();
        } catch (Exception ex) {
            Log.w(TAG, "Failed saving active route from car", ex);
        }
    }

    public void setNavigationActiveFromCar(boolean active) {
        CarSyncState state = loadCarState();
        state.isNavigationActive = active;
        saveCarStateFromCar(state);
    }

    public void saveCarStateFromCar(CarSyncState state) {
        if (state == null) return;
        try {
            JSONObject vis = new JSONObject();
            vis.put("googleSatellite", state.visibility.googleSatellite);
            vis.put("hillshade", state.visibility.hillshade);
            vis.put("hikingTrails", state.visibility.hikingTrails);
            vis.put("offroad4x4", state.visibility.offroad4x4);
            vis.put("pois", state.visibility.pois);
            vis.put("poiWater", state.visibility.poiWater);
            vis.put("poiHeritage", state.visibility.poiHeritage);
            vis.put("poiCampsites", state.visibility.poiCampsites);
            vis.put("poiOffroad", state.visibility.poiOffroad);
            vis.put("poiPeaks", state.visibility.poiPeaks);
            vis.put("poiUser", state.visibility.poiUser);

            JSONObject obj = new JSONObject();
            obj.put("isNavigationActive", state.isNavigationActive);
            obj.put("theme", state.theme);
            obj.put("visibility", vis);
            obj.put("updatedAt", String.valueOf(System.currentTimeMillis()));

            synchronized (stateLock) {
                writeUtf8Atomic(new File(carSyncDir, FILE_CAR_STATE), obj.toString());
            }
            notifyStateUpdated();
        } catch (Exception ex) {
            Log.w(TAG, "Failed saving car_state.json", ex);
        }
    }

    public List<CarRoute> loadSavedRoutes() {
        String json;
        synchronized (stateLock) {
            json = readUtf8OrNull(new File(carSyncDir, FILE_SAVED_ROUTES));
        }
        if (json == null || json.trim().isEmpty()) {
            return Collections.emptyList();
        }
        try {
            JSONArray arr = new JSONArray(json);
            List<CarRoute> result = new ArrayList<>(arr.length());
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                CarRoute parsed = parseCarRoute(item);
                if (parsed != null) {
                    result.add(parsed);
                }
            }
            return result;
        } catch (Exception ex) {
            Log.w(TAG, "Failed parsing saved_routes.json", ex);
            return Collections.emptyList();
        }
    }

    public CarSyncState loadCarState() {
        CarSyncState state = new CarSyncState();
        String json;
        synchronized (stateLock) {
            json = readUtf8OrNull(new File(carSyncDir, FILE_CAR_STATE));
        }
        if (json == null || json.trim().isEmpty()) {
            return state;
        }
        try {
            JSONObject obj = new JSONObject(json);
            state.isNavigationActive = obj.optBoolean("isNavigationActive", false);
            String theme = obj.optString("theme", "topo-day");
            state.theme = "topo-dark".equals(theme) ? "topo-dark" : "topo-day";
            state.updatedAt = obj.optString("updatedAt", "");
            JSONObject vis = obj.optJSONObject("visibility");
            if (vis != null) {
                state.visibility.googleSatellite = vis.optBoolean("googleSatellite", false);
                state.visibility.hillshade = vis.optBoolean("hillshade", true);
                state.visibility.hikingTrails = vis.optBoolean("hikingTrails", true);
                state.visibility.offroad4x4 = vis.optBoolean("offroad4x4", true);
                state.visibility.pois = vis.optBoolean("pois", true);
                state.visibility.poiWater = vis.optBoolean("poiWater", true);
                state.visibility.poiHeritage = vis.optBoolean("poiHeritage", true);
                state.visibility.poiCampsites = vis.optBoolean("poiCampsites", true);
                state.visibility.poiOffroad = vis.optBoolean("poiOffroad", true);
                state.visibility.poiPeaks = vis.optBoolean("poiPeaks", true);
                state.visibility.poiUser = vis.optBoolean("poiUser", true);
            }
        } catch (Exception ex) {
            Log.w(TAG, "Failed parsing car_state.json", ex);
        }
        return state;
    }

    private CarRoute parseCarRoute(JSONObject obj) {
        if (obj == null) return null;
        String id = obj.optString("id", "");
        String name = obj.optString("name", "מסלול שטח");
        String sourceFormat = obj.optString("sourceFormat", "planned");
        double distanceKm = obj.optDouble("distanceKm", 0.0);
        int ascentMeters = obj.optInt("ascentMeters", 0);
        int descentMeters = obj.optInt("descentMeters", 0);
        String color = obj.optString("color", "#f97316");
        boolean visible = obj.optBoolean("visible", true);
        JSONObject geojson = obj.optJSONObject("geojson");
        String geoJsonString = geojson != null ? geojson.toString() : "{\"type\":\"FeatureCollection\",\"features\":[]}";

        List<double[]> points = new ArrayList<>();
        if (geojson != null) {
            JSONArray features = geojson.optJSONArray("features");
            if (features != null) {
                for (int fIdx = 0; fIdx < features.length(); fIdx++) {
                    JSONObject feat = features.optJSONObject(fIdx);
                    if (feat == null) continue;
                    JSONObject geom = feat.optJSONObject("geometry");
                    if (geom == null) continue;
                    String gType = geom.optString("type", "");
                    if ("LineString".equals(gType)) {
                        appendCoords(geom.optJSONArray("coordinates"), points);
                    } else if ("MultiLineString".equals(gType)) {
                        JSONArray multi = geom.optJSONArray("coordinates");
                        if (multi != null) {
                            for (int s = 0; s < multi.length(); s++) {
                                appendCoords(multi.optJSONArray(s), points);
                            }
                        }
                    }
                }
            }
        }
        if (id.isEmpty()) return null;
        return new CarRoute(
            id,
            name,
            sourceFormat,
            distanceKm,
            ascentMeters,
            descentMeters,
            color,
            visible,
            geoJsonString,
            points
        );
    }

    private static void appendCoords(JSONArray coords, List<double[]> out) {
        if (coords == null) return;
        for (int i = 0; i < coords.length(); i++) {
            JSONArray pt = coords.optJSONArray(i);
            if (pt == null || pt.length() < 2) continue;
            double lon = pt.optDouble(0, Double.NaN);
            double lat = pt.optDouble(1, Double.NaN);
            if (!Double.isNaN(lon) && !Double.isNaN(lat)) {
                out.add(new double[] { lon, lat });
            }
        }
    }

    public int countUserPois() {
        ensureUserPoisLoaded();
        return userPois.size();
    }

    private void ensureUserPoisLoaded() {
        if (userPois.isEmpty() && new File(carSyncDir, FILE_USER_POIS).exists()) {
            synchronized (stateLock) {
                reloadUserPoisLocked();
            }
        }
    }

    private void reloadUserPoisLocked() {
        String json = readUtf8OrNull(new File(carSyncDir, FILE_USER_POIS));
        if (json == null || json.trim().isEmpty()) {
            userPois = Collections.emptyList();
            return;
        }
        try {
            JSONArray arr = new JSONArray(json);
            List<CarPoi> list = new ArrayList<>(arr.length());
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String id = o.optString("id", "");
                String nameHe = o.optString("nameHe", o.optString("name", ""));
                String nameEn = o.optString("nameEn", nameHe);
                String cat = o.optString("category", "user").intern();
                String sub = o.optString("subcategory", "poi").intern();
                double lon = o.optDouble("lon", Double.NaN);
                double lat = o.optDouble("lat", Double.NaN);
                if (id.isEmpty() || nameHe.isEmpty() || Double.isNaN(lon) || Double.isNaN(lat)) continue;
                Integer ele = o.has("ele") && !o.isNull("ele") ? o.optInt("ele") : null;
                String snippet = firstNonEmpty(
                    o.optString("userNotes", ""),
                    o.optString("difficulty4x4", ""),
                    o.optString("waterStatus", ""),
                    o.optString("descHe", "")
                );
                int priority = o.optInt("priority", 15);
                list.add(new CarPoi(id, nameHe, nameEn, cat, sub, lon, lat, ele, truncate(snippet, 120), priority));
            }
            userPois = Collections.unmodifiableList(list);
        } catch (Exception ex) {
            Log.w(TAG, "Failed parsing user_pois.json", ex);
        }
    }

    private void ensureDeletedPoiIdsLoaded() {
        if (deletedPoiIds.isEmpty() && new File(carSyncDir, FILE_DELETED_POI_IDS).exists()) {
            synchronized (stateLock) {
                reloadDeletedPoiIdsLocked();
            }
        }
    }

    private void reloadDeletedPoiIdsLocked() {
        String json = readUtf8OrNull(new File(carSyncDir, FILE_DELETED_POI_IDS));
        if (json == null || json.trim().isEmpty()) {
            deletedPoiIds = Collections.emptySet();
            return;
        }
        try {
            JSONArray arr = new JSONArray(json);
            Set<String> ids = new HashSet<>(arr.length());
            for (int i = 0; i < arr.length(); i++) {
                String id = arr.optString(i, "");
                if (!id.isEmpty()) {
                    ids.add(id);
                }
            }
            deletedPoiIds = Collections.unmodifiableSet(ids);
        } catch (Exception ex) {
            Log.w(TAG, "Failed parsing deleted_poi_ids.json", ex);
        }
    }

    public void ensurePoisLoadedAsync() {
        ensureUserPoisLoaded();
        ensureDeletedPoiIdsLoaded();
        if (basePoisLoaded.get() && offroadPoisLoaded.get() && compactGeoJsonBuilt) {
            return;
        }
        poiLoaderExecutor.execute(() -> {
            try {
                if (basePoisLoaded.compareAndSet(false, true)) {
                    List<CarPoi> core = streamPoisFromAsset("public/data/Israel.pois.geojson", Integer.MAX_VALUE);
                    bundledCorePois = Collections.unmodifiableList(core);
                    poiRevision.incrementAndGet();
                }
                if (!compactGeoJsonBuilt) {
                    writeCompactPoiGeoJsonFile();
                    notifyStateUpdated();
                }
                if (offroadPoisLoaded.compareAndSet(false, true)) {
                    List<CarPoi> extra = streamPoisFromAsset("public/data/Israel.offroad.pois.geojson", 20000);
                    offroadPois = Collections.unmodifiableList(extra);
                    poiRevision.incrementAndGet();
                    compactGeoJsonBuilt = false;
                    writeCompactPoiGeoJsonFile();
                    notifyStateUpdated();
                }
            } catch (Exception ex) {
                Log.w(TAG, "Background POI load warning", ex);
            }
        });
    }

    public File getCompactPoisGeoJsonFile() {
        File file = new File(carSyncDir, FILE_COMPACT_POIS_GEOJSON);
        return (file.exists() && file.length() > 32) ? file : null;
    }

    private void writeCompactPoiGeoJsonFile() {
        List<CarPoi> merged = getAllLoadedPoisSnapshot();
        // Keep up to 18,000 highest-priority POIs for fast native C++ GeoJsonSource tiling
        List<CarPoi> sorted = new ArrayList<>(merged);
        Collections.sort(sorted, Comparator.comparingInt(p -> p.priority));
        int limit = Math.min(sorted.size(), 18000);

        File target = new File(carSyncDir, FILE_COMPACT_POIS_GEOJSON);
        File tmp = new File(carSyncDir, FILE_COMPACT_POIS_GEOJSON + ".tmp");
        try (FileOutputStream fos = new FileOutputStream(tmp, false)) {
            fos.write("{\"type\":\"FeatureCollection\",\"features\":[".getBytes(StandardCharsets.UTF_8));
            boolean first = true;
            for (int i = 0; i < limit; i++) {
                CarPoi p = sorted.get(i);
                if (!first) fos.write(',');
                first = false;
                StringBuilder sb = new StringBuilder(160);
                sb.append("{\"type\":\"Feature\",\"id\":").append(JSONObject.quote(p.id))
                    .append(",\"geometry\":{\"type\":\"Point\",\"coordinates\":[")
                    .append(p.lon).append(',').append(p.lat).append("]},\"properties\":{")
                    .append("\"id\":").append(JSONObject.quote(p.id))
                    .append(",\"nameHe\":").append(JSONObject.quote(p.nameHe))
                    .append(",\"category\":").append(JSONObject.quote(p.category))
                    .append(",\"subcategory\":").append(JSONObject.quote(p.subcategory))
                    .append(",\"priority\":").append(p.priority)
                    .append("}}");
                fos.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            }
            fos.write("]}".getBytes(StandardCharsets.UTF_8));
            fos.getFD().sync();
            if (target.exists()) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.renameTo(target);
            compactGeoJsonBuilt = true;
        } catch (Exception ex) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            Log.w(TAG, "Failed writing compact_pois.geojson", ex);
        }
    }

    private List<CarPoi> streamPoisFromAsset(String assetPath, int maxFeatures) {
        List<CarPoi> list = new ArrayList<>(Math.min(maxFeatures, 7000));
        try (InputStream is = appContext.getAssets().open(assetPath);
             BufferedInputStream bis = new BufferedInputStream(is, 32768);
             JsonReader reader = new JsonReader(new InputStreamReader(bis, StandardCharsets.UTF_8))) {
            reader.beginObject();
            while (reader.hasNext()) {
                String key = reader.nextName();
                if ("features".equals(key)) {
                    reader.beginArray();
                    int idx = 0;
                    while (reader.hasNext() && list.size() < maxFeatures) {
                        CarPoi poi = readGeoJsonFeature(reader, idx++);
                        if (poi != null) {
                            list.add(poi);
                        }
                    }
                    while (reader.hasNext()) {
                        reader.skipValue();
                    }
                    reader.endArray();
                } else {
                    reader.skipValue();
                }
            }
            reader.endObject();
        } catch (Exception ex) {
            Log.w(TAG, "Asset POI streaming skipped (" + assetPath + "): " + ex.getMessage());
        }
        return list;
    }

    private CarPoi readGeoJsonFeature(JsonReader reader, int index) throws IOException {
        String featId = "";
        double lon = Double.NaN;
        double lat = Double.NaN;
        String propId = "";
        String nameHe = "";
        String nameEn = "";
        String category = "heritage";
        String subcategory = "poi";
        Integer ele = null;
        String waterStatus = "";
        String difficulty = "";
        String descHe = "";
        int priority = 200 + index;

        reader.beginObject();
        while (reader.hasNext()) {
            String key = reader.nextName();
            if ("id".equals(key) && reader.peek() != JsonToken.NULL) {
                featId = reader.nextString();
            } else if ("geometry".equals(key) && reader.peek() == JsonToken.BEGIN_OBJECT) {
                reader.beginObject();
                while (reader.hasNext()) {
                    String gk = reader.nextName();
                    if ("coordinates".equals(gk) && reader.peek() == JsonToken.BEGIN_ARRAY) {
                        reader.beginArray();
                        if (reader.hasNext()) lon = reader.nextDouble();
                        if (reader.hasNext()) lat = reader.nextDouble();
                        while (reader.hasNext()) reader.skipValue();
                        reader.endArray();
                    } else {
                        reader.skipValue();
                    }
                }
                reader.endObject();
            } else if ("properties".equals(key) && reader.peek() == JsonToken.BEGIN_OBJECT) {
                reader.beginObject();
                while (reader.hasNext()) {
                    String pk = reader.nextName();
                    JsonToken tok = reader.peek();
                    if (tok == JsonToken.NULL) {
                        reader.nextNull();
                        continue;
                    }
                    switch (pk) {
                        case "id":
                            propId = reader.nextString();
                            break;
                        case "nameHe":
                            nameHe = reader.nextString();
                            break;
                        case "name":
                            if (nameHe.isEmpty()) nameHe = reader.nextString();
                            else reader.skipValue();
                            break;
                        case "nameEn":
                            nameEn = reader.nextString();
                            break;
                        case "category":
                            category = reader.nextString().intern();
                            break;
                        case "subcategory":
                            subcategory = reader.nextString().intern();
                            break;
                        case "ele":
                            ele = (int) Math.round(reader.nextDouble());
                            break;
                        case "waterStatus":
                            waterStatus = reader.nextString();
                            break;
                        case "difficulty4x4":
                            difficulty = reader.nextString();
                            break;
                        case "descHe":
                            descHe = reader.nextString();
                            break;
                        case "priority":
                            priority = (int) Math.round(reader.nextDouble());
                            break;
                        default:
                            reader.skipValue();
                            break;
                    }
                }
                reader.endObject();
            } else {
                reader.skipValue();
            }
        }
        reader.endObject();

        String finalId = !propId.isEmpty() ? propId : featId;
        if (finalId.isEmpty() || nameHe.isEmpty() || Double.isNaN(lon) || Double.isNaN(lat)) {
            return null;
        }
        if (nameEn.isEmpty()) nameEn = nameHe;
        String snippet = truncate(firstNonEmpty(difficulty, waterStatus, descHe), 120);
        return new CarPoi(finalId, nameHe, nameEn, category, subcategory, lon, lat, ele, snippet, priority);
    }

    public List<CarPoi> getAllLoadedPoisSnapshot() {
        ensureUserPoisLoaded();
        ensureDeletedPoiIdsLoaded();
        List<CarPoi> u = userPois;
        List<CarPoi> b = bundledCorePois;
        List<CarPoi> o = offroadPois;
        Set<String> deleted = deletedPoiIds;
        Set<String> seenIds = new HashSet<>(u.size() + 32);
        List<CarPoi> merged = new ArrayList<>(u.size() + b.size() + o.size());
        for (CarPoi p : u) {
            if (deleted.contains(p.id) || !seenIds.add(p.id)) continue;
            merged.add(p);
        }
        for (CarPoi p : b) {
            if (deleted.contains(p.id) || seenIds.contains(p.id)) continue;
            seenIds.add(p.id);
            merged.add(p);
        }
        for (CarPoi p : o) {
            if (deleted.contains(p.id) || seenIds.contains(p.id)) continue;
            seenIds.add(p.id);
            merged.add(p);
        }
        return merged;
    }

    public List<CarPoi> queryNearbyOrSearchPois(
        String query,
        String categoryFilter,
        double refLon,
        double refLat,
        int limit
    ) {
        ensureUserPoisLoaded();
        if (!basePoisLoaded.get()) {
            ensurePoisLoadedAsync();
        }
        String q = query != null ? query.trim().toLowerCase(Locale.ROOT) : "";
        boolean hasQuery = !q.isEmpty();

        List<CarPoi> all = getAllLoadedPoisSnapshot();
        final class ScoredPoi {
            final CarPoi poi;
            final double distMeters;

            ScoredPoi(CarPoi poi, double distMeters) {
                this.poi = poi;
                this.distMeters = distMeters;
            }
        }
        List<ScoredPoi> matches = new ArrayList<>();
        for (CarPoi p : all) {
            if (categoryFilter != null && !"all".equals(categoryFilter) && !categoryFilter.equals(p.category)) {
                continue;
            }
            if (hasQuery) {
                String nHe = p.nameHe.toLowerCase(Locale.ROOT);
                String nEn = p.nameEn.toLowerCase(Locale.ROOT);
                String snip = p.snippet.toLowerCase(Locale.ROOT);
                if (!nHe.contains(q) && !nEn.contains(q) && !snip.contains(q)) {
                    continue;
                }
            }
            double dist = haversineMeters(refLat, refLon, p.lat, p.lon);
            matches.add(new ScoredPoi(p, dist));
        }

        Collections.sort(matches, (a, b) -> Double.compare(a.distMeters, b.distMeters));
        int count = Math.min(limit, matches.size());
        List<CarPoi> out = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            out.add(matches.get(i).poi);
        }
        return out;
    }

    public static double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371000.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a =
            Math.sin(dLat / 2.0) * Math.sin(dLat / 2.0) +
            Math.cos(Math.toRadians(lat1)) *
                Math.cos(Math.toRadians(lat2)) *
                Math.sin(dLon / 2.0) *
                Math.sin(dLon / 2.0);
        return r * 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
    }

    private static String firstNonEmpty(String... values) {
        for (String v : values) {
            if (v != null && !v.trim().isEmpty()) {
                return v.trim();
            }
        }
        return "";
    }

    private static String truncate(String s, int maxLen) {
        if (s == null) return "";
        if (s.length() <= maxLen) return s;
        return s.substring(0, Math.max(0, maxLen - 1)) + "…";
    }
}
