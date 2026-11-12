package com.navapp.outdoor.israel.car;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PointF;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.car.app.SurfaceCallback;
import androidx.car.app.SurfaceContainer;
import com.navapp.outdoor.israel.NativeMapStore;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.maplibre.android.camera.CameraPosition;
import org.maplibre.android.camera.CameraUpdateFactory;
import org.maplibre.android.geometry.LatLng;
import org.maplibre.android.geometry.LatLngBounds;
import org.maplibre.android.maps.MapLibreMap;
import org.maplibre.android.maps.Style;
import org.maplibre.android.style.expressions.Expression;
import org.maplibre.android.style.layers.CircleLayer;
import org.maplibre.android.style.layers.Layer;
import org.maplibre.android.style.layers.LineLayer;
import org.maplibre.android.style.layers.Property;
import org.maplibre.android.style.layers.PropertyFactory;
import org.maplibre.android.style.layers.SymbolLayer;
import org.maplibre.android.style.sources.GeoJsonSource;

/**
 * Owns the VirtualDisplay + MapLibre Native OpenGL Surface lifecycle for Android Auto,
 * applies synced IHM Day/Dark/Satellite styles, renders all saved trails, active route,
 * offline 18k POI symbols, target POI beacon, and live rotated GPS puck.
 */
public final class CarMapController implements SurfaceCallback {
    private static final String TAG = "CarMapController";

    public enum OrientationMode {
        HEADING_UP,
        NORTH_UP
    }

    private static final String SRC_SAVED_ROUTES = "car-saved-routes-src";
    private static final String LAYER_SAVED_ROUTES = "car-saved-routes-line";
    private static final String SRC_ACTIVE_ROUTE = "car-active-route-src";
    private static final String LAYER_ACTIVE_ROUTE = "car-active-route-line";
    private static final String LAYER_ACTIVE_CASING = "car-active-route-casing";
    private static final String SRC_ROUTE_ENDPOINTS = "car-route-endpoints-src";
    private static final String LAYER_ROUTE_ENDPOINTS = "car-route-endpoints-layer";
    private static final String SRC_ISRAEL_POIS = "car-israel-pois-src";
    private static final String LAYER_ISRAEL_POIS_PEAKS = "car-israel-pois-peaks";
    private static final String LAYER_ISRAEL_POIS_MIDZOOM = "car-israel-pois-midzoom";
    private static final String LAYER_ISRAEL_POIS = "car-israel-pois-labels";
    private static final String SRC_TARGET_POI = "car-target-poi-src";
    private static final String LAYER_TARGET_POI = "car-target-poi-layer";
    private static final String SRC_USER_LOC = "car-user-loc-src";
    private static final String LAYER_USER_LOC = "car-user-loc-layer";

    private static final String IMG_CAR_USER_PUCK = "car-user-puck";
    private static final String IMG_CAR_TARGET_PIN = "car-target-pin";

    private final Context appContext;
    private final NativeMapStore store;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private VirtualDisplay virtualDisplay;
    private CarMapPresentation presentation;
    private MapLibreMap mapLibreMap;
    private Style loadedStyle;

    private int surfaceWidth = 0;
    private int surfaceHeight = 0;
    private final Rect stableArea = new Rect();
    private boolean hasStableArea = false;

    private OrientationMode orientationMode = OrientationMode.HEADING_UP;
    private boolean panMode = false;
    private boolean followingUser = true;
    private double targetZoom = 14.8;
    private String lastAppliedStyleSignature = "";
    private File lastPoiGeoJsonFileLoaded = null;
    private long lastPoiGeoJsonModified = 0L;
    private long lastPoiRevisionLoaded = -1L;

    private NativeMapStore.CarSyncState currentSyncState;
    private NativeMapStore.CarRoute currentActiveRoute;
    private List<NativeMapStore.CarRoute> currentSavedRoutes = java.util.Collections.emptyList();
    private NativeMapStore.CarPoi currentTargetPoi;
    private CarNavLocationTracker.NavTelemetry latestTelemetry;
    private Runnable stateChangedHook;

    public CarMapController(Context context) {
        this.appContext = context.getApplicationContext();
        this.store = NativeMapStore.getInstance(this.appContext);
        this.currentSyncState = store.loadCarState();
    }

    public void setStateChangedHook(Runnable hook) {
        this.stateChangedHook = hook;
    }

    public OrientationMode getOrientationMode() {
        return orientationMode;
    }

    public boolean isPanMode() {
        return panMode;
    }

    public void setPanMode(boolean enabled) {
        this.panMode = enabled;
        if (!enabled) {
            recenter();
        }
    }

    public void toggleOrientationMode() {
        orientationMode = orientationMode == OrientationMode.HEADING_UP
            ? OrientationMode.NORTH_UP
            : OrientationMode.HEADING_UP;
        followingUser = true;
        panMode = false;
        applyCameraToTelemetry(true);
    }

    public void recenter() {
        panMode = false;
        followingUser = true;
        applyCameraToTelemetry(true);
    }

    public void zoomIn() {
        mainHandler.post(() -> {
            if (mapLibreMap == null) return;
            double next = Math.min(18.5, mapLibreMap.getCameraPosition().zoom + 1.0);
            targetZoom = next;
            mapLibreMap.animateCamera(CameraUpdateFactory.zoomTo(next), 220);
        });
    }

    public void zoomOut() {
        mainHandler.post(() -> {
            if (mapLibreMap == null) return;
            double next = Math.max(7.0, mapLibreMap.getCameraPosition().zoom - 1.0);
            targetZoom = next;
            mapLibreMap.animateCamera(CameraUpdateFactory.zoomTo(next), 220);
        });
    }

    public void focusOnRoute(NativeMapStore.CarRoute route) {
        if (route == null || route.flattenedPoints.isEmpty()) return;
        mainHandler.post(() -> {
            panMode = false;
            if (mapLibreMap == null) return;
            if (route.flattenedPoints.size() == 1) {
                double[] p = route.flattenedPoints.get(0);
                mapLibreMap.animateCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(p[1], p[0]), 14.8), 450);
                return;
            }
            LatLngBounds.Builder b = new LatLngBounds.Builder();
            int step = Math.max(1, route.flattenedPoints.size() / 200);
            for (int i = 0; i < route.flattenedPoints.size(); i += step) {
                double[] pt = route.flattenedPoints.get(i);
                b.include(new LatLng(pt[1], pt[0]));
            }
            double[] last = route.flattenedPoints.get(route.flattenedPoints.size() - 1);
            b.include(new LatLng(last[1], last[0]));
            try {
                int pad = Math.max(60, Math.min(surfaceWidth, surfaceHeight) / 8);
                mapLibreMap.animateCamera(
                    CameraUpdateFactory.newLatLngBounds(
                        b.build(),
                        pad + stableLeftInset(),
                        pad + stableTopInset(),
                        pad + stableRightInset(),
                        pad + stableBottomInset()
                    ),
                    500
                );
            } catch (Exception ex) {
                double[] start = route.flattenedPoints.get(0);
                mapLibreMap.animateCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(start[1], start[0]), 14.0), 400);
            }
        });
    }

    public void focusOnPoi(NativeMapStore.CarPoi poi) {
        if (poi == null) return;
        this.currentTargetPoi = poi;
        mainHandler.post(() -> {
            refreshDynamicOverlays();
            if (mapLibreMap != null) {
                panMode = true;
                followingUser = false;
                mapLibreMap.animateCamera(
                    CameraUpdateFactory.newLatLngZoom(new LatLng(poi.lat, poi.lon), 15.2),
                    400
                );
            }
        });
    }

    public void updateSyncedData(
        NativeMapStore.CarSyncState syncState,
        NativeMapStore.CarRoute activeRoute,
        List<NativeMapStore.CarRoute> savedRoutes,
        NativeMapStore.CarPoi targetPoi,
        boolean forceStyleReload
    ) {
        this.currentSyncState = syncState != null ? syncState : new NativeMapStore.CarSyncState();
        this.currentActiveRoute = activeRoute;
        this.currentSavedRoutes = savedRoutes != null ? savedRoutes : java.util.Collections.emptyList();
        this.currentTargetPoi = targetPoi;

        mainHandler.post(() -> {
            if (mapLibreMap == null) return;
            String nextSig = buildStyleSignature(this.currentSyncState);
            if (forceStyleReload || !nextSig.equals(lastAppliedStyleSignature)) {
                loadMapStyle();
            } else {
                refreshDynamicOverlays();
            }
        });
    }

    public void updateTelemetry(CarNavLocationTracker.NavTelemetry telemetry) {
        this.latestTelemetry = telemetry;
        mainHandler.post(() -> {
            if (mapLibreMap == null) return;
            updateUserLocationGeoJson();
            if (followingUser && !panMode && telemetry != null && telemetry.hasFix) {
                applyCameraToTelemetry(false);
            }
        });
    }

    // ---- SurfaceCallback ----

    @Override
    public void onSurfaceAvailable(@NonNull SurfaceContainer surfaceContainer) {
        mainHandler.post(() -> {
            destroyPresentationLocked();
            if (surfaceContainer.getSurface() == null) return;
            surfaceWidth = Math.max(1, surfaceContainer.getWidth());
            surfaceHeight = Math.max(1, surfaceContainer.getHeight());
            int dpi = Math.max(120, surfaceContainer.getDpi());

            DisplayManager dm = (DisplayManager) appContext.getSystemService(Context.DISPLAY_SERVICE);
            if (dm == null) return;

            try {
                virtualDisplay = dm.createVirtualDisplay(
                    "NavApp-CarMap",
                    surfaceWidth,
                    surfaceHeight,
                    dpi,
                    surfaceContainer.getSurface(),
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
                );
            } catch (Exception ex) {
                Log.e(TAG, "Failed creating VirtualDisplay for car surface", ex);
                return;
            }

            if (virtualDisplay == null) return;

            presentation = new CarMapPresentation(
                appContext,
                virtualDisplay.getDisplay(),
                map -> {
                    this.mapLibreMap = map;
                    this.lastAppliedStyleSignature = "";
                    loadMapStyle();
                    if (stateChangedHook != null) {
                        stateChangedHook.run();
                    }
                }
            );
            presentation.show();
            presentation.dispatchStart();
            presentation.dispatchResume();
        });
    }

    @Override
    public void onVisibleAreaChanged(@NonNull Rect visibleArea) {
        // Stable area handles safe insets for overlays and HUD positioning.
    }

    @Override
    public void onStableAreaChanged(@NonNull Rect stableArea) {
        mainHandler.post(() -> {
            this.stableArea.set(stableArea);
            this.hasStableArea = !stableArea.isEmpty() && surfaceWidth > 0 && surfaceHeight > 0;
            if (mapLibreMap != null && followingUser && !panMode) {
                applyCameraToTelemetry(false);
            }
        });
    }

    @Override
    public void onScroll(float distanceX, float distanceY) {
        mainHandler.post(() -> {
            if (mapLibreMap == null) return;
            followingUser = false;
            panMode = true;
            mapLibreMap.scrollBy(-distanceX, -distanceY, 0L);
        });
    }

    @Override
    public void onFling(float velocityX, float velocityY) {
        mainHandler.post(() -> {
            if (mapLibreMap == null) return;
            followingUser = false;
            panMode = true;
            mapLibreMap.scrollBy(-velocityX * 0.12f, -velocityY * 0.12f, 220L);
        });
    }

    @Override
    public void onScale(float focusX, float focusY, float scaleFactor) {
        mainHandler.post(() -> {
            if (mapLibreMap == null || scaleFactor <= 0f) return;
            double currentZoom = mapLibreMap.getCameraPosition().zoom;
            double deltaZoom = Math.log(scaleFactor) / Math.log(2.0);
            double nextZoom = Math.max(6.5, Math.min(18.5, currentZoom + deltaZoom));
            targetZoom = nextZoom;
            mapLibreMap.setZoom(nextZoom, new PointF(focusX, focusY), 0L);
        });
    }

    @Override
    public void onSurfaceDestroyed(@NonNull SurfaceContainer surfaceContainer) {
        mainHandler.post(this::destroyPresentationLocked);
    }

    public void destroy() {
        mainHandler.post(this::destroyPresentationLocked);
    }

    private void destroyPresentationLocked() {
        loadedStyle = null;
        mapLibreMap = null;
        lastAppliedStyleSignature = "";
        lastPoiGeoJsonFileLoaded = null;
        lastPoiRevisionLoaded = -1L;
        if (presentation != null) {
            try {
                presentation.dispatchPause();
                presentation.dispatchStop();
                presentation.dispatchDestroy();
                presentation.dismiss();
            } catch (Exception ignored) {
            }
            presentation = null;
        }
        if (virtualDisplay != null) {
            try {
                virtualDisplay.release();
            } catch (Exception ignored) {
            }
            virtualDisplay = null;
        }
    }

    // ---- Style & Overlays ----

    private String buildStyleSignature(NativeMapStore.CarSyncState s) {
        NativeMapStore.CarVisibility v = s.visibility;
        return s.theme
            + "|sat=" + v.googleSatellite
            + "|hs=" + v.hillshade
            + "|ht=" + v.hikingTrails
            + "|4x4=" + v.offroad4x4
            + "|poi=" + v.pois + v.poiWater + v.poiHeritage + v.poiCampsites + v.poiOffroad + v.poiPeaks + v.poiUser
            + "|osm=" + store.hasOfflineOsm()
            + "|dem=" + store.hasOfflineDem();
    }

    private void loadMapStyle() {
        if (mapLibreMap == null) return;
        NativeMapStore.CarSyncState st = currentSyncState != null ? currentSyncState : new NativeMapStore.CarSyncState();
        String json = CarStyleBuilder.buildStyleJson(appContext, st);
        lastAppliedStyleSignature = buildStyleSignature(st);
        lastPoiGeoJsonFileLoaded = null;
        lastPoiRevisionLoaded = -1L;
        mapLibreMap.setStyle(new Style.Builder().fromJson(json), style -> {
            if (this.mapLibreMap == null || style == null) return;
            this.loadedStyle = style;
            ensureProceduralImages(style);
            setupOverlaySourcesAndLayers(style);
            refreshDynamicOverlays();
            applyCameraToTelemetry(false);
        });
    }

    private void ensureProceduralImages(Style style) {
        if (style.getImage(IMG_CAR_USER_PUCK) == null) {
            style.addImage(IMG_CAR_USER_PUCK, createUserPuckBitmap());
        }
        if (style.getImage(IMG_CAR_TARGET_PIN) == null) {
            style.addImage(IMG_CAR_TARGET_PIN, createTargetPinBitmap());
        }
    }

    private void setupOverlaySourcesAndLayers(Style style) {
        boolean isDark = currentSyncState != null && "topo-dark".equals(currentSyncState.theme);
        String casingColor = isDark ? "#0f172a" : "#ffffff";

        // 1. Saved routes (secondary)
        if (style.getSource(SRC_SAVED_ROUTES) == null) {
            style.addSource(new GeoJsonSource(SRC_SAVED_ROUTES));
            LineLayer savedLayer = new LineLayer(LAYER_SAVED_ROUTES, SRC_SAVED_ROUTES);
            savedLayer.setProperties(
                PropertyFactory.lineCap(Property.LINE_CAP_ROUND),
                PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
                PropertyFactory.lineColor(Expression.coalesce(Expression.get("color"), Expression.literal("#f59e0b"))),
                PropertyFactory.lineWidth(3.5f),
                PropertyFactory.lineOpacity(0.7f)
            );
            style.addLayer(savedLayer);
        }

        // 2. Active route (highlighter + casing)
        if (style.getSource(SRC_ACTIVE_ROUTE) == null) {
            style.addSource(new GeoJsonSource(SRC_ACTIVE_ROUTE));
            LineLayer activeLine = new LineLayer(LAYER_ACTIVE_ROUTE, SRC_ACTIVE_ROUTE);
            activeLine.setProperties(
                PropertyFactory.lineCap(Property.LINE_CAP_ROUND),
                PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
                PropertyFactory.lineColor("#f97316"),
                PropertyFactory.lineOpacity(0.55f),
                PropertyFactory.lineWidth(
                    Expression.interpolate(
                        Expression.linear(),
                        Expression.zoom(),
                        Expression.stop(9, 8f),
                        Expression.stop(13, 12f),
                        Expression.stop(16, 16f)
                    )
                )
            );
            style.addLayer(activeLine);

            LineLayer activeCasing = new LineLayer(LAYER_ACTIVE_CASING, SRC_ACTIVE_ROUTE);
            activeCasing.setProperties(
                PropertyFactory.lineCap(Property.LINE_CAP_ROUND),
                PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
                PropertyFactory.lineColor(casingColor),
                PropertyFactory.lineWidth(2.0f),
                PropertyFactory.lineOpacity(0.92f),
                PropertyFactory.lineGapWidth(
                    Expression.interpolate(
                        Expression.linear(),
                        Expression.zoom(),
                        Expression.stop(9, 7.5f),
                        Expression.stop(13, 11.5f),
                        Expression.stop(16, 15.5f)
                    )
                )
            );
            style.addLayer(activeCasing);
        }

        // 3. Route endpoints
        if (style.getSource(SRC_ROUTE_ENDPOINTS) == null) {
            style.addSource(new GeoJsonSource(SRC_ROUTE_ENDPOINTS));
            CircleLayer endpoints = new CircleLayer(LAYER_ROUTE_ENDPOINTS, SRC_ROUTE_ENDPOINTS);
            endpoints.setProperties(
                PropertyFactory.circleRadius(6.5f),
                PropertyFactory.circleColor(
                    Expression.match(
                        Expression.get("kind"),
                        Expression.literal("#ef4444"),
                        Expression.stop("start", "#10b981")
                    )
                ),
                PropertyFactory.circleStrokeWidth(2.2f),
                PropertyFactory.circleStrokeColor("#ffffff")
            );
            style.addLayer(endpoints);
        }

        // 4. Unified 18k Outdoor POIs layer
        if (style.getSource(SRC_ISRAEL_POIS) == null) {
            File poiFile = store.getCompactPoisGeoJsonFile();
            if (poiFile != null) {
                style.addSource(new GeoJsonSource(SRC_ISRAEL_POIS, poiFile.toURI()));
                lastPoiGeoJsonFileLoaded = poiFile;
                lastPoiGeoJsonModified = poiFile.lastModified();
                lastPoiRevisionLoaded = store.getPoiRevision();
            } else {
                style.addSource(new GeoJsonSource(SRC_ISRAEL_POIS));
            }

            Expression poiIcons = buildPoiIconExpression();
            Expression poiTextColors = buildPoiTextColorExpression(isDark);
            Expression poiNameExpr = Expression.coalesce(Expression.get("nameHe"), Expression.literal(""));
            String haloColor = isDark ? "#0b1015" : "#ffffff";

            SymbolLayer peaksLayer = new SymbolLayer(LAYER_ISRAEL_POIS_PEAKS, SRC_ISRAEL_POIS);
            peaksLayer.setMinZoom(11.5f);
            peaksLayer.setProperties(
                PropertyFactory.iconImage(poiIcons),
                PropertyFactory.iconSize(buildPoiIconSizeExpression(0.94f)),
                PropertyFactory.iconPadding(1.5f),
                PropertyFactory.iconAnchor(Property.ICON_ANCHOR_CENTER),
                PropertyFactory.iconAllowOverlap(false),
                PropertyFactory.textField(
                    Expression.step(Expression.zoom(), Expression.literal(""), Expression.stop(12.5f, poiNameExpr))
                ),
                PropertyFactory.textFont(new String[] { "bold", "Arial", "Tahoma", "sans-serif" }),
                PropertyFactory.textSize(13.0f),
                PropertyFactory.textOffset(new Float[] { 0f, 1.0f }),
                PropertyFactory.textAnchor(Property.TEXT_ANCHOR_TOP),
                PropertyFactory.textMaxWidth(9.0f),
                PropertyFactory.textOptional(true),
                PropertyFactory.textColor(poiTextColors),
                PropertyFactory.textHaloColor(haloColor),
                PropertyFactory.textHaloWidth(2.8f)
            );
            style.addLayer(peaksLayer);

            SymbolLayer midzoomLayer = new SymbolLayer(LAYER_ISRAEL_POIS_MIDZOOM, SRC_ISRAEL_POIS);
            midzoomLayer.setMinZoom(13.0f);
            midzoomLayer.setProperties(
                PropertyFactory.iconImage(poiIcons),
                PropertyFactory.iconSize(buildPoiIconSizeExpression(0.98f)),
                PropertyFactory.iconPadding(1.5f),
                PropertyFactory.iconAnchor(Property.ICON_ANCHOR_CENTER),
                PropertyFactory.iconAllowOverlap(false),
                PropertyFactory.textField(
                    Expression.step(Expression.zoom(), Expression.literal(""), Expression.stop(14.0f, poiNameExpr))
                ),
                PropertyFactory.textFont(new String[] { "bold", "Arial", "Tahoma", "sans-serif" }),
                PropertyFactory.textSize(13.0f),
                PropertyFactory.textOffset(new Float[] { 0f, 1.0f }),
                PropertyFactory.textAnchor(Property.TEXT_ANCHOR_TOP),
                PropertyFactory.textMaxWidth(9.0f),
                PropertyFactory.textOptional(true),
                PropertyFactory.textColor(poiTextColors),
                PropertyFactory.textHaloColor(haloColor),
                PropertyFactory.textHaloWidth(2.8f)
            );
            style.addLayer(midzoomLayer);

            SymbolLayer poiLayer = new SymbolLayer(LAYER_ISRAEL_POIS, SRC_ISRAEL_POIS);
            poiLayer.setMinZoom(14.0f);
            poiLayer.setProperties(
                PropertyFactory.iconImage(poiIcons),
                PropertyFactory.iconSize(buildPoiIconSizeExpression(1.02f)),
                PropertyFactory.iconPadding(1.5f),
                PropertyFactory.iconAnchor(Property.ICON_ANCHOR_CENTER),
                PropertyFactory.iconAllowOverlap(false),
                PropertyFactory.textField(poiNameExpr),
                PropertyFactory.textFont(new String[] { "bold", "Arial", "Tahoma", "sans-serif" }),
                PropertyFactory.textSize(13.0f),
                PropertyFactory.textOffset(new Float[] { 0f, 1.0f }),
                PropertyFactory.textAnchor(Property.TEXT_ANCHOR_TOP),
                PropertyFactory.textMaxWidth(9.0f),
                PropertyFactory.textOptional(true),
                PropertyFactory.textColor(poiTextColors),
                PropertyFactory.textHaloColor(haloColor),
                PropertyFactory.textHaloWidth(2.8f)
            );
            style.addLayer(poiLayer);
        }

        // 5. Target POI Beacon (always visible across all zooms)
        if (style.getSource(SRC_TARGET_POI) == null) {
            style.addSource(new GeoJsonSource(SRC_TARGET_POI));
            SymbolLayer targetLayer = new SymbolLayer(LAYER_TARGET_POI, SRC_TARGET_POI);
            targetLayer.setProperties(
                PropertyFactory.iconImage(IMG_CAR_TARGET_PIN),
                PropertyFactory.iconSize(1.0f),
                PropertyFactory.iconAllowOverlap(true),
                PropertyFactory.iconIgnorePlacement(true),
                PropertyFactory.textField(Expression.coalesce(Expression.get("nameHe"), Expression.literal(""))),
                PropertyFactory.textFont(new String[] { "bold", "Arial", "Tahoma", "sans-serif" }),
                PropertyFactory.textSize(14.5f),
                PropertyFactory.textOffset(new Float[] { 0f, 1.35f }),
                PropertyFactory.textAnchor(Property.TEXT_ANCHOR_TOP),
                PropertyFactory.textAllowOverlap(true),
                PropertyFactory.textColor("#fbbf24"),
                PropertyFactory.textHaloColor("#0f172a"),
                PropertyFactory.textHaloWidth(3.0f)
            );
            style.addLayer(targetLayer);
        }

        // 6. User Location Puck (topmost)
        if (style.getSource(SRC_USER_LOC) == null) {
            style.addSource(new GeoJsonSource(SRC_USER_LOC));
            SymbolLayer userLayer = new SymbolLayer(LAYER_USER_LOC, SRC_USER_LOC);
            userLayer.setProperties(
                PropertyFactory.iconImage(IMG_CAR_USER_PUCK),
                PropertyFactory.iconSize(1.05f),
                PropertyFactory.iconAllowOverlap(true),
                PropertyFactory.iconIgnorePlacement(true),
                PropertyFactory.iconRotate(Expression.coalesce(Expression.get("bearing"), Expression.literal(0.0))),
                PropertyFactory.iconRotationAlignment(Property.ICON_ROTATION_ALIGNMENT_MAP)
            );
            style.addLayer(userLayer);
        }
    }

    private void refreshDynamicOverlays() {
        Style style = this.loadedStyle;
        if (style == null || !style.isFullyLoaded()) return;

        // Saved routes GeoJSON
        GeoJsonSource savedSrc = style.getSourceAs(SRC_SAVED_ROUTES);
        if (savedSrc != null) {
            savedSrc.setGeoJson(buildSavedRoutesGeoJson());
        }

        // Active route GeoJSON + color + endpoints
        GeoJsonSource activeSrc = style.getSourceAs(SRC_ACTIVE_ROUTE);
        if (activeSrc != null) {
            activeSrc.setGeoJson(
                currentActiveRoute != null && currentActiveRoute.visible
                    ? currentActiveRoute.geoJsonString
                    : "{\"type\":\"FeatureCollection\",\"features\":[]}"
            );
        }
        Layer activeLineLayer = style.getLayer(LAYER_ACTIVE_ROUTE);
        if (activeLineLayer != null && currentActiveRoute != null) {
            activeLineLayer.setProperties(PropertyFactory.lineColor(currentActiveRoute.color));
        }

        GeoJsonSource epSrc = style.getSourceAs(SRC_ROUTE_ENDPOINTS);
        if (epSrc != null) {
            epSrc.setGeoJson(buildEndpointsGeoJson());
        }

        // Offline POIs GeoJson file update + category visibility filter
        File poiFile = store.getCompactPoisGeoJsonFile();
        GeoJsonSource poiSrc = style.getSourceAs(SRC_ISRAEL_POIS);
        if (poiSrc != null && poiFile != null) {
            long curRev = store.getPoiRevision();
            boolean fileChanged =
                lastPoiGeoJsonFileLoaded == null ||
                !poiFile.equals(lastPoiGeoJsonFileLoaded) ||
                poiFile.lastModified() != lastPoiGeoJsonModified ||
                curRev != lastPoiRevisionLoaded;
            if (fileChanged) {
                poiSrc.setUri(poiFile.toURI());
                lastPoiGeoJsonFileLoaded = poiFile;
                lastPoiGeoJsonModified = poiFile.lastModified();
                lastPoiRevisionLoaded = curRev;
            }
        }
        if (currentSyncState != null) {
            NativeMapStore.CarVisibility vis = currentSyncState.visibility;
            boolean showPois = vis.pois && (vis.poiWater || vis.poiOffroad || vis.poiHeritage || vis.poiCampsites || vis.poiPeaks || vis.poiUser);
            String visProp = showPois ? Property.VISIBLE : Property.NONE;

            SymbolLayer peaksLayer = style.getLayerAs(LAYER_ISRAEL_POIS_PEAKS);
            if (peaksLayer != null) {
                peaksLayer.setProperties(PropertyFactory.visibility(visProp));
                peaksLayer.setFilter(buildPoiFilterExpression(vis, new String[] { "peak" }));
            }

            SymbolLayer midzoomLayer = style.getLayerAs(LAYER_ISRAEL_POIS_MIDZOOM);
            if (midzoomLayer != null) {
                midzoomLayer.setProperties(PropertyFactory.visibility(visProp));
                midzoomLayer.setFilter(buildPoiFilterExpression(vis, new String[] { "campsite", "heritage" }));
            }

            SymbolLayer poiLayer = style.getLayerAs(LAYER_ISRAEL_POIS);
            if (poiLayer != null) {
                poiLayer.setProperties(PropertyFactory.visibility(visProp));
                poiLayer.setFilter(buildPoiFilterExpression(vis, new String[] { "water", "offroad", "user" }));
            }
        }

        // Target POI pin
        GeoJsonSource targetSrc = style.getSourceAs(SRC_TARGET_POI);
        if (targetSrc != null) {
            targetSrc.setGeoJson(buildTargetPoiGeoJson());
        }

        updateUserLocationGeoJson();
    }

    private void updateUserLocationGeoJson() {
        Style style = this.loadedStyle;
        if (style == null || !style.isFullyLoaded()) return;
        GeoJsonSource userSrc = style.getSourceAs(SRC_USER_LOC);
        if (userSrc == null) return;
        CarNavLocationTracker.NavTelemetry t = latestTelemetry;
        if (t == null || !t.hasFix) {
            userSrc.setGeoJson("{\"type\":\"FeatureCollection\",\"features\":[]}");
            return;
        }
        String json = "{\"type\":\"FeatureCollection\",\"features\":[{\"type\":\"Feature\",\"properties\":{\"bearing\":"
            + t.bearingDeg
            + "},\"geometry\":{\"type\":\"Point\",\"coordinates\":["
            + t.lon
            + ","
            + t.lat
            + "]}}]}";
        userSrc.setGeoJson(json);
    }

    private void applyCameraToTelemetry(boolean animate) {
        if (mapLibreMap == null) return;
        double lon = CarNavLocationTracker.DEFAULT_ISRAEL_LON;
        double lat = CarNavLocationTracker.DEFAULT_ISRAEL_LAT;
        double bearing = 0.0;

        if (latestTelemetry != null && latestTelemetry.hasFix) {
            lon = latestTelemetry.lon;
            lat = latestTelemetry.lat;
            bearing = latestTelemetry.bearingDeg;
        } else if (currentTargetPoi != null) {
            lon = currentTargetPoi.lon;
            lat = currentTargetPoi.lat;
        } else if (currentActiveRoute != null && !currentActiveRoute.flattenedPoints.isEmpty()) {
            double[] start = currentActiveRoute.flattenedPoints.get(0);
            lon = start[0];
            lat = start[1];
        }

        boolean headingMode = orientationMode == OrientationMode.HEADING_UP;
        double cameraBearing = headingMode ? bearing : 0.0;
        double tilt = headingMode ? 32.0 : 0.0;
        double zoom = Math.max(7.0, Math.min(18.5, targetZoom));

        CameraPosition.Builder builder = new CameraPosition.Builder()
            .target(new LatLng(lat, lon))
            .zoom(zoom)
            .bearing(cameraBearing)
            .tilt(tilt);

        if (hasStableArea) {
            builder.padding(
                stableLeftInset(),
                stableTopInset(),
                stableRightInset(),
                stableBottomInset()
            );
        }

        if (animate) {
            mapLibreMap.animateCamera(CameraUpdateFactory.newCameraPosition(builder.build()), 350);
        } else {
            mapLibreMap.easeCamera(CameraUpdateFactory.newCameraPosition(builder.build()), 280);
        }
    }

    private int stableLeftInset() {
        return hasStableArea ? Math.max(0, stableArea.left) : 0;
    }

    private int stableTopInset() {
        return hasStableArea ? Math.max(0, stableArea.top) : 0;
    }

    private int stableRightInset() {
        return hasStableArea ? Math.max(0, surfaceWidth - stableArea.right) : 0;
    }

    private int stableBottomInset() {
        return hasStableArea ? Math.max(0, surfaceHeight - stableArea.bottom) : 0;
    }

    private String buildSavedRoutesGeoJson() {
        if (currentSavedRoutes == null || currentSavedRoutes.isEmpty()) {
            return "{\"type\":\"FeatureCollection\",\"features\":[]}";
        }
        String activeId = currentActiveRoute != null ? currentActiveRoute.id : "";
        JSONArray outFeatures = new JSONArray();
        try {
            for (NativeMapStore.CarRoute route : currentSavedRoutes) {
                if (route == null || !route.visible || route.id.equals(activeId)) continue;
                JSONObject fc = new JSONObject(route.geoJsonString);
                JSONArray feats = fc.optJSONArray("features");
                if (feats == null) continue;
                for (int i = 0; i < feats.length(); i++) {
                    JSONObject f = feats.optJSONObject(i);
                    if (f == null) continue;
                    JSONObject props = f.optJSONObject("properties");
                    if (props == null) {
                        props = new JSONObject();
                        f.put("properties", props);
                    }
                    props.put("color", route.color);
                    outFeatures.put(f);
                }
            }
            JSONObject out = new JSONObject();
            out.put("type", "FeatureCollection");
            out.put("features", outFeatures);
            return out.toString();
        } catch (Exception ex) {
            return "{\"type\":\"FeatureCollection\",\"features\":[]}";
        }
    }

    private String buildEndpointsGeoJson() {
        if (currentActiveRoute == null || !currentActiveRoute.visible || currentActiveRoute.flattenedPoints.isEmpty()) {
            return "{\"type\":\"FeatureCollection\",\"features\":[]}";
        }
        double[] start = currentActiveRoute.getStartCoord();
        double[] end = currentActiveRoute.getEndCoord();
        if (start == null || end == null) {
            return "{\"type\":\"FeatureCollection\",\"features\":[]}";
        }
        return "{\"type\":\"FeatureCollection\",\"features\":["
            + "{\"type\":\"Feature\",\"properties\":{\"kind\":\"start\"},\"geometry\":{\"type\":\"Point\",\"coordinates\":["
            + start[0] + "," + start[1] + "]}},"
            + "{\"type\":\"Feature\",\"properties\":{\"kind\":\"end\"},\"geometry\":{\"type\":\"Point\",\"coordinates\":["
            + end[0] + "," + end[1] + "]}}]}";
    }

    private String buildTargetPoiGeoJson() {
        if (currentTargetPoi == null) {
            return "{\"type\":\"FeatureCollection\",\"features\":[]}";
        }
        return "{\"type\":\"FeatureCollection\",\"features\":[{"
            + "\"type\":\"Feature\","
            + "\"properties\":{\"nameHe\":" + JSONObject.quote(currentTargetPoi.nameHe) + "},"
            + "\"geometry\":{\"type\":\"Point\",\"coordinates\":[" + currentTargetPoi.lon + "," + currentTargetPoi.lat + "]}"
            + "}]}";
    }

    private static Expression buildPoiFilterExpression(NativeMapStore.CarVisibility vis, String[] allowedCategories) {
        List<String> cats = new ArrayList<>(allowedCategories.length);
        for (String cat : allowedCategories) {
            boolean enabled = false;
            if ("water".equals(cat)) enabled = vis.poiWater;
            else if ("offroad".equals(cat)) enabled = vis.poiOffroad;
            else if ("heritage".equals(cat)) enabled = vis.poiHeritage;
            else if ("campsite".equals(cat)) enabled = vis.poiCampsites;
            else if ("peak".equals(cat)) enabled = vis.poiPeaks;
            else if ("user".equals(cat)) enabled = vis.poiUser;
            if (enabled) cats.add(cat);
        }
        if (cats.isEmpty()) {
            return Expression.eq(Expression.literal(1), Expression.literal(2));
        }
        return Expression.in(Expression.get("category"), Expression.literal(cats.toArray(new Object[0])));
    }

    private static Expression buildPoiIconExpression() {
        Expression sub = Expression.coalesce(Expression.get("subcategory"), Expression.literal(""));
        Expression waterExpr = Expression.match(
            sub,
            Expression.literal("poi-water-spring"),
            Expression.stop("water_pool", "poi-water-pool"),
            Expression.stop("water_hole", "poi-water-pool"),
            Expression.stop("waterhole", "poi-water-pool"),
            Expression.stop("stream_pool", "poi-water-pool"),
            Expression.stop("pool", "poi-water-pool"),
            Expression.stop("swimming", "poi-water-pool"),
            Expression.stop("waterfall", "poi-water-waterfall"),
            Expression.stop("cistern", "poi-water-cistern"),
            Expression.stop("water_well", "poi-water-cistern"),
            Expression.stop("well", "poi-water-cistern"),
            Expression.stop("birket", "poi-water-cistern"),
            Expression.stop("maagora", "poi-water-cistern"),
            Expression.stop("drinking_water", "poi-water-tap"),
            Expression.stop("tap", "poi-water-tap"),
            Expression.stop("fountain", "poi-water-tap")
        );
        Expression offroadExpr = Expression.match(
            sub,
            Expression.literal("poi-offroad-pass"),
            Expression.stop("blocked_road", "poi-offroad-blocked"),
            Expression.stop("gate_closed", "poi-offroad-blocked"),
            Expression.stop("gate", "poi-offroad-blocked"),
            Expression.stop("barrier", "poi-offroad-blocked"),
            Expression.stop("blocked", "poi-offroad-blocked"),
            Expression.stop("danger", "poi-offroad-danger"),
            Expression.stop("hazard", "poi-offroad-danger"),
            Expression.stop("obstacle", "poi-offroad-danger"),
            Expression.stop("rock_step", "poi-offroad-danger"),
            Expression.stop("ford", "poi-offroad-danger"),
            Expression.stop("mud", "poi-offroad-mud"),
            Expression.stop("wadi_crossing", "poi-offroad-mud"),
            Expression.stop("floods", "poi-offroad-mud"),
            Expression.stop("offroad_track", "poi-offroad-track"),
            Expression.stop("scenic_4x4", "poi-offroad-track"),
            Expression.stop("parking_4x4", "poi-offroad-track"),
            Expression.stop("ratag_info", "poi-offroad-track"),
            Expression.stop("wifi_sos", "poi-offroad-track"),
            Expression.stop("fuel_4x4", "poi-offroad-service"),
            Expression.stop("recovery_service", "poi-offroad-service"),
            Expression.stop("clunker", "poi-offroad-service")
        );
        Expression campExpr = Expression.match(
            sub,
            Expression.literal("poi-campsite-night"),
            Expression.stop("picnic_site", "poi-campsite-picnic"),
            Expression.stop("picnic", "poi-campsite-picnic"),
            Expression.stop("shade_grove", "poi-campsite-picnic"),
            Expression.stop("khan", "poi-campsite-khan"),
            Expression.stop("shelter", "poi-campsite-khan"),
            Expression.stop("wilderness_hut", "poi-campsite-khan"),
            Expression.stop("alpine_hut", "poi-campsite-khan"),
            Expression.stop("alpinehut", "poi-campsite-khan"),
            Expression.stop("coffee_spot", "poi-campsite-fire"),
            Expression.stop("rest_stop", "poi-campsite-fire"),
            Expression.stop("bonfire", "poi-campsite-fire")
        );
        Expression heritageExpr = Expression.match(
            sub,
            Expression.literal("poi-heritage-landmark"),
            Expression.stop("ruins", "poi-heritage-ruins"),
            Expression.stop("archaeological_site", "poi-heritage-ruins"),
            Expression.stop("fort", "poi-heritage-ruins"),
            Expression.stop("castle", "poi-heritage-ruins"),
            Expression.stop("cave", "poi-heritage-cave"),
            Expression.stop("cave_entrance", "poi-heritage-cave"),
            Expression.stop("viewpoint", "poi-heritage-viewpoint"),
            Expression.stop("scenic_view", "poi-heritage-viewpoint"),
            Expression.stop("monument", "poi-heritage-monument"),
            Expression.stop("memorial", "poi-heritage-monument"),
            Expression.stop("tomb", "poi-heritage-monument"),
            Expression.stop("nature_site", "poi-heritage-nature"),
            Expression.stop("flowers", "poi-heritage-nature"),
            Expression.stop("ancient_tree", "poi-heritage-nature"),
            Expression.stop("geology", "poi-heritage-nature"),
            Expression.stop("botany", "poi-heritage-nature"),
            Expression.stop("holy_site", "poi-heritage-holy"),
            Expression.stop("synagogue", "poi-heritage-holy"),
            Expression.stop("monastery", "poi-heritage-holy"),
            Expression.stop("mosque", "poi-heritage-holy")
        );
        Expression peakExpr = Expression.match(
            sub,
            Expression.literal("poi-peak-summit"),
            Expression.stop("saddle", "poi-peak-saddle"),
            Expression.stop("ridge", "poi-peak-saddle"),
            Expression.stop("cliff", "poi-peak-saddle"),
            Expression.stop("crater", "poi-peak-crater"),
            Expression.stop("volcano", "poi-peak-crater"),
            Expression.stop("tel_ridge", "poi-peak-crater"),
            Expression.stop("fire_lookout", "poi-peak-tower"),
            Expression.stop("beacon", "poi-peak-tower"),
            Expression.stop("tower_peak", "poi-peak-tower")
        );
        Expression userExpr = Expression.match(
            sub,
            Expression.literal("poi-user-pin"),
            Expression.stop("waypoint", "poi-user-flag"),
            Expression.stop("flag", "poi-user-flag"),
            Expression.stop("target", "poi-user-flag"),
            Expression.stop("field_note", "poi-user-note"),
            Expression.stop("report", "poi-user-note"),
            Expression.stop("favorite", "poi-user-star"),
            Expression.stop("star", "poi-user-star"),
            Expression.stop("civic_amenity", "poi-user-service"),
            Expression.stop("hospital", "poi-user-service"),
            Expression.stop("restaurant", "poi-user-service"),
            Expression.stop("shop", "poi-user-service")
        );

        return Expression.match(
            Expression.get("category"),
            Expression.literal("poi-heritage-landmark"),
            Expression.stop("water", waterExpr),
            Expression.stop("offroad", offroadExpr),
            Expression.stop("campsite", campExpr),
            Expression.stop("heritage", heritageExpr),
            Expression.stop("peak", peakExpr),
            Expression.stop("user", userExpr)
        );
    }

    private static Expression buildPoiIconSizeExpression(float categoryScale) {
        return Expression.interpolate(
            Expression.linear(),
            Expression.zoom(),
            Expression.stop(11.5f, 0.45f * categoryScale),
            Expression.stop(13.0f, 0.62f * categoryScale),
            Expression.stop(14.0f, 0.78f * categoryScale),
            Expression.stop(15.5f, 1.00f * categoryScale),
            Expression.stop(17.5f, 1.28f * categoryScale)
        );
    }

    private static Expression buildPoiTextColorExpression(boolean isDark) {
        return Expression.match(
            Expression.get("category"),
            Expression.literal(isDark ? "#FFE119" : "#7A6300"),
            Expression.stop("water", isDark ? "#38BDF8" : "#0369A1"),
            Expression.stop("offroad", isDark ? "#FB7185" : "#B80F3A"),
            Expression.stop("campsite", isDark ? "#4ADE80" : "#006B00"),
            Expression.stop("heritage", isDark ? "#FFE119" : "#7A6300"),
            Expression.stop("peak", isDark ? "#E2E8F0" : "#000000"),
            Expression.stop("user", isDark ? "#D875F5" : "#6B1286")
        );
    }

    // ---- Procedural Canvas Bitmaps ----

    private static Bitmap createUserPuckBitmap() {
        int s = 64;
        Bitmap bmp = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        float cx = s / 2f;
        float cy = s / 2f;

        Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
        halo.setColor(0x4438BDF8);
        c.drawCircle(cx, cy, 28f, halo);

        Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
        border.setColor(Color.WHITE);
        c.drawCircle(cx, cy, 19f, border);

        Paint inner = new Paint(Paint.ANTI_ALIAS_FLAG);
        inner.setColor(0xFF0EA5E9);
        c.drawCircle(cx, cy, 15.5f, inner);

        // Directional North/Heading Chevron inside the puck
        Paint arrow = new Paint(Paint.ANTI_ALIAS_FLAG);
        arrow.setColor(Color.WHITE);
        arrow.setStyle(Paint.Style.FILL);
        Path p = new Path();
        p.moveTo(cx, cy - 10f);
        p.lineTo(cx + 7.5f, cy + 7f);
        p.lineTo(cx, cy + 3.5f);
        p.lineTo(cx - 7.5f, cy + 7f);
        p.close();
        c.drawPath(p, arrow);
        return bmp;
    }

    private static Bitmap createTargetPinBitmap() {
        int s = 56;
        Bitmap bmp = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        float cx = s / 2f;
        float cy = s / 2f;

        Paint outer = new Paint(Paint.ANTI_ALIAS_FLAG);
        outer.setColor(0x55F59E0B);
        c.drawCircle(cx, cy, 24f, outer);

        Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
        border.setColor(Color.WHITE);
        c.drawCircle(cx, cy, 15f, border);

        Paint core = new Paint(Paint.ANTI_ALIAS_FLAG);
        core.setColor(0xFFF59E0B);
        c.drawCircle(cx, cy, 11.5f, core);
        return bmp;
    }
}
