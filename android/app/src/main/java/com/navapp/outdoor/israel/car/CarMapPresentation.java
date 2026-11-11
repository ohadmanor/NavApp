package com.navapp.outdoor.israel.car;

import android.app.Presentation;
import android.content.Context;
import android.os.Bundle;
import android.view.Display;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import org.maplibre.android.MapLibre;
import org.maplibre.android.camera.CameraPosition;
import org.maplibre.android.geometry.LatLng;
import org.maplibre.android.maps.MapLibreMapOptions;
import org.maplibre.android.maps.MapView;
import org.maplibre.android.maps.OnMapReadyCallback;

/**
 * Offscreen Android Auto VirtualDisplay Presentation hosting an OpenGL texture-mode
 * MapLibre Native {@link MapView}.
 */
public final class CarMapPresentation extends Presentation {
    private final OnMapReadyCallback mapReadyCallback;
    private MapView mapView;
    private boolean destroyed = false;

    public CarMapPresentation(
        Context outerContext,
        Display display,
        OnMapReadyCallback mapReadyCallback
    ) {
        super(outerContext, display);
        this.mapReadyCallback = mapReadyCallback;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Context ctx = getContext();
        MapLibre.getInstance(ctx.getApplicationContext());

        MapLibreMapOptions options = MapLibreMapOptions.createFromAttributes(ctx)
            .textureMode(true)
            .compassEnabled(false)
            .logoEnabled(false)
            .attributionEnabled(false)
            .rotateGesturesEnabled(false)
            .tiltGesturesEnabled(false)
            .minZoomPreference(6.0)
            .maxZoomPreference(19.0)
            .camera(
                new CameraPosition.Builder()
                    .target(new LatLng(CarNavLocationTracker.DEFAULT_ISRAEL_LAT, CarNavLocationTracker.DEFAULT_ISRAEL_LON))
                    .zoom(14.5)
                    .build()
            );

        FrameLayout root = new FrameLayout(ctx);
        mapView = new MapView(ctx, options);
        mapView.setLayoutParams(
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
        root.addView(mapView);
        setContentView(root);

        mapView.onCreate(savedInstanceState);
        if (mapReadyCallback != null) {
            mapView.getMapAsync(mapReadyCallback);
        }
    }

    public MapView getMapView() {
        return mapView;
    }

    public void dispatchStart() {
        if (!destroyed && mapView != null) {
            mapView.onStart();
        }
    }

    public void dispatchResume() {
        if (!destroyed && mapView != null) {
            mapView.onResume();
        }
    }

    public void dispatchPause() {
        if (!destroyed && mapView != null) {
            mapView.onPause();
        }
    }

    public void dispatchStop() {
        if (!destroyed && mapView != null) {
            mapView.onStop();
        }
    }

    public void dispatchDestroy() {
        if (destroyed) return;
        destroyed = true;
        if (mapView != null) {
            mapView.onDestroy();
            mapView = null;
        }
    }
}
