package com.navapp.outdoor.israel.car;

import androidx.annotation.NonNull;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.constraints.ConstraintManager;
import androidx.car.app.model.Action;
import androidx.car.app.model.ItemList;
import androidx.car.app.model.Row;
import androidx.car.app.model.SearchTemplate;
import androidx.car.app.model.Template;
import com.navapp.outdoor.israel.NativeMapStore;
import java.util.List;
import java.util.Locale;

/**
 * Offline Android Auto SearchTemplate searching all 25k+ Israel POIs (Water, 4x4 Passes,
 * Campsites, Heritage, Peaks & User POIs) sorted by distance from live GPS position.
 */
public final class CarSearchScreen extends Screen implements SearchTemplate.SearchCallback {
    private final NavCarSession session;
    private final String categoryFilter;
    private String currentQuery = "";

    public CarSearchScreen(
        @NonNull CarContext carContext,
        @NonNull NavCarSession session,
        String categoryFilter
    ) {
        super(carContext);
        this.session = session;
        this.categoryFilter = categoryFilter;
    }

    @Override
    public void onSearchTextChanged(@NonNull String searchText) {
        this.currentQuery = searchText != null ? searchText : "";
        invalidate();
    }

    @Override
    public void onSearchSubmitted(@NonNull String searchText) {
        this.currentQuery = searchText != null ? searchText : "";
        invalidate();
    }

    @NonNull
    @Override
    public Template onGetTemplate() {
        CarContext ctx = getCarContext();
        CarNavLocationTracker.NavTelemetry t = session.getLatestTelemetry();
        double refLon = t != null ? t.lon : CarNavLocationTracker.DEFAULT_ISRAEL_LON;
        double refLat = t != null ? t.lat : CarNavLocationTracker.DEFAULT_ISRAEL_LAT;

        int maxItems = 6;
        try {
            ConstraintManager cm = ctx.getCarService(ConstraintManager.class);
            maxItems = Math.max(6, cm.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST));
        } catch (Exception ignored) {
        }

        List<NativeMapStore.CarPoi> results = session
            .getStore()
            .queryNearbyOrSearchPois(currentQuery, categoryFilter, refLon, refLat, maxItems);

        ItemList.Builder list = new ItemList.Builder()
            .setNoItemsMessage("לא נמצאו נקודות עניין תואמות");

        for (NativeMapStore.CarPoi p : results) {
            double distM = NativeMapStore.haversineMeters(refLat, refLon, p.lat, p.lon);
            String distText = distM < 1000.0
                ? String.format(Locale.US, "%d מ׳", Math.round(distM / 10.0) * 10L)
                : String.format(Locale.US, "%.1f ק״מ", distM / 1000.0);
            String details = distText + "  •  " + formatCategoryHe(p.category);
            if (p.snippet != null && !p.snippet.isEmpty()) {
                details += "  •  " + p.snippet;
            }
            list.addItem(
                new Row.Builder()
                    .setTitle(p.nameHe)
                    .addText(details)
                    .setOnClickListener(() -> session.selectPoiAndNavigate(p))
                    .build()
            );
        }

        String hint = "חפש מעיין, מעלה, חניון או יעד...";
        if ("water".equals(categoryFilter)) hint = "חפש מעיין / גב מים...";
        else if ("offroad".equals(categoryFilter)) hint = "חפש מעלה / עבירות 4x4...";
        else if ("campsite".equals(categoryFilter)) hint = "חפש חניון לילה...";
        else if ("heritage".equals(categoryFilter)) hint = "חפש תצפית / עתיקות...";

        return new SearchTemplate.Builder(this)
            .setHeaderAction(Action.BACK)
            .setSearchHint(hint)
            .setInitialSearchText(currentQuery)
            .setShowKeyboardByDefault(categoryFilter == null)
            .setItemList(list.build())
            .build();
    }

    private static String formatCategoryHe(String cat) {
        if ("water".equals(cat)) return "מים";
        if ("offroad".equals(cat)) return "4x4";
        if ("campsite".equals(cat)) return "לינה";
        if ("peak".equals(cat)) return "פסגה";
        if ("user".equals(cat)) return "אישי";
        return "עניין";
    }
}
