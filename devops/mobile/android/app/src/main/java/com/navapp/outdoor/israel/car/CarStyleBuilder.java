package com.navapp.outdoor.israel.car;

import android.content.Context;
import android.util.Log;
import com.navapp.outdoor.israel.LocalCarServer;
import com.navapp.outdoor.israel.NativeMapStore;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Loads the precompiled MapLibre Native v8 vector style templates (`car_style_day.json` /
 * `car_style_dark.json`), injects live offline PMTiles paths + loopback glyph server URL,
 * and applies layer visibility flags synced from the phone app.
 */
public final class CarStyleBuilder {
    private static final String TAG = "CarStyleBuilder";
    private static final String ASSET_STYLE_DAY = "car_style_day.json";
    private static final String ASSET_STYLE_DARK = "car_style_dark.json";
    private static final String CAR_SPRITE_URL = "asset://public/assets/sprites/sprite";

    private CarStyleBuilder() {}

    public static String buildStyleJson(Context context, NativeMapStore.CarSyncState syncState) {
        NativeMapStore store = NativeMapStore.getInstance(context);
        LocalCarServer server = LocalCarServer.getInstance(context);

        boolean isDark = syncState != null && "topo-dark".equals(syncState.theme);
        String assetName = isDark ? ASSET_STYLE_DARK : ASSET_STYLE_DAY;
        String rawJson = readAssetUtf8(context, assetName);
        if (rawJson == null || rawJson.isEmpty()) {
            return "{\"version\":8,\"sources\":{},\"layers\":[{\"id\":\"bg\",\"type\":\"background\",\"paint\":{\"background-color\":\"#111827\"}}]}";
        }

        String osmUrl = store.getMapLibreOsmUrl();
        String demUrl = store.getMapLibreDemUrl();
        String glyphsUrl = server.getGlyphsTemplateUrl();

        String hydrated = rawJson
            .replace("__OSM_URL__", osmUrl)
            .replace("__DEM_URL__", demUrl)
            .replace("__SPRITE_URL__", CAR_SPRITE_URL)
            .replace("__GLYPHS_URL__", glyphsUrl);

        if (syncState == null) {
            return hydrated;
        }

        try {
            JSONObject root = new JSONObject(hydrated);
            JSONArray layers = root.optJSONArray("layers");
            if (layers != null) {
                NativeMapStore.CarVisibility vis = syncState.visibility;
                for (int i = 0; i < layers.length(); i++) {
                    JSONObject layer = layers.optJSONObject(i);
                    if (layer == null) continue;
                    String id = layer.optString("id", "");
                    String type = layer.optString("type", "");
                    Boolean targetVis = computeLayerVisibility(id, type, vis);
                    if (targetVis != null) {
                        JSONObject layout = layer.optJSONObject("layout");
                        if (layout == null) {
                            layout = new JSONObject();
                            layer.put("layout", layout);
                        }
                        layout.put("visibility", targetVis ? "visible" : "none");
                    }
                }
            }
            return root.toString();
        } catch (Exception ex) {
            Log.w(TAG, "Failed applying visibility transforms to car style", ex);
            return hydrated;
        }
    }

    private static Boolean computeLayerVisibility(
        String layerId,
        String layerType,
        NativeMapStore.CarVisibility vis
    ) {
        if ("google-satellite-layer".equals(layerId)) {
            return vis.googleSatellite;
        }
        if ("background".equals(layerId)) {
            return !vis.googleSatellite;
        }
        if ("Terrain".equals(layerId)) {
            return !vis.googleSatellite && vis.hillshade;
        }
        if (vis.googleSatellite && "fill".equals(layerType)) {
            if ("area-military".equals(layerId)) {
                return null;
            }
            return false;
        }
        if ("trail-line-track".equals(layerId)) {
            return vis.offroad4x4;
        }
        if (
            layerId.startsWith("trail-israel-") ||
            layerId.startsWith("trail-regional-") ||
            "trail-line-path".equals(layerId) ||
            "trail-line-cycleway".equals(layerId) ||
            "trail-line-road".equals(layerId) ||
            "casing-marked-path".equals(layerId) ||
            "casing-marked-cycleway".equals(layerId) ||
            "casing-minor-colour2".equals(layerId)
        ) {
            return vis.hikingTrails;
        }
        if ("name-peak".equals(layerId)) {
            return vis.pois && vis.poiPeaks;
        }
        if (
            "name-water-point".equals(layerId) ||
            "water-hole".equals(layerId) ||
            "water-well".equals(layerId) ||
            "water-waterfall".equals(layerId) ||
            "water-tank".equals(layerId) ||
            "water-drinking".equals(layerId)
        ) {
            return vis.pois && vis.poiWater;
        }
        if ("icon-camp_site".equals(layerId) || "icon-picnic".equals(layerId)) {
            return vis.pois && vis.poiCampsites;
        }
        if (
            "icon-viewpoint".equals(layerId) ||
            "icon-cave".equals(layerId) ||
            "icon-ruins".equals(layerId) ||
            "icon-archaeological".equals(layerId) ||
            "icon-memorial".equals(layerId) ||
            "icon-holy".equals(layerId) ||
            "icon-jewish".equals(layerId) ||
            "icon-muslim".equals(layerId) ||
            "icon-christian".equals(layerId)
        ) {
            return vis.pois && vis.poiHeritage;
        }
        if (
            "icon-tree".equals(layerId) ||
            "icon-rail_station".equals(layerId) ||
            "icon-fuel".equals(layerId) ||
            "icon-parking".equals(layerId) ||
            "icon-guidepost".equals(layerId)
        ) {
            return vis.pois;
        }
        return null;
    }

    private static String readAssetUtf8(Context context, String assetName) {
        try (InputStream is = context.getAssets().open(assetName);
             ByteArrayOutputStream bos = new ByteArrayOutputStream(65536)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return bos.toString(StandardCharsets.UTF_8.name());
        } catch (IOException ex) {
            Log.e(TAG, "Unable to read asset " + assetName, ex);
            return null;
        }
    }
}
