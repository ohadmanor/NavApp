package com.navapp.outdoor.israel.car;

import androidx.annotation.NonNull;
import androidx.car.app.CarContext;
import androidx.car.app.CarToast;
import androidx.car.app.Screen;
import androidx.car.app.model.Action;
import androidx.car.app.model.CarIcon;
import androidx.car.app.model.Header;
import androidx.car.app.model.ItemList;
import androidx.car.app.model.ListTemplate;
import androidx.car.app.model.Row;
import androidx.car.app.model.Template;
import androidx.core.graphics.drawable.IconCompat;
import com.navapp.outdoor.israel.NativeMapStore;
import com.navapp.outdoor.israel.R;
import java.util.List;

/**
 * Compact 6-item-safe main Android Auto menu screen linking Saved Routes,
 * nearby categorized POIs (Water, 4x4, Campsites, Search), Style mode, and Offline status.
 */
public final class CarMenuScreen extends Screen {
    private final NavCarSession session;

    public CarMenuScreen(@NonNull CarContext carContext, @NonNull NavCarSession session) {
        super(carContext);
        this.session = session;
    }

    @NonNull
    @Override
    public Template onGetTemplate() {
        CarContext ctx = getCarContext();
        NativeMapStore store = session.getStore();
        List<NativeMapStore.CarRoute> routes = session.getSavedRoutes();
        NativeMapStore.CarSyncState syncState = session.getSyncState();

        String modeLabel;
        if (syncState.visibility.googleSatellite) {
            modeLabel = "לוויין + שבילי שטח";
        } else if ("topo-dark".equals(syncState.theme)) {
            modeLabel = "טופוגרפי לילה";
        } else {
            modeLabel = "טופוגרפי יום (IHM)";
        }

        boolean osmOk = store.hasOfflineOsm();
        boolean demOk = store.hasOfflineDem();
        String offlineSummary = "אופליין: "
            + (osmOk ? "מפה ✓" : "אונליין")
            + " • "
            + (demOk ? "גבהים ✓" : "DEM ברשת");

        ItemList.Builder list = new ItemList.Builder();

        list.addItem(
            new Row.Builder()
                .setTitle("חיפוש נקודת עניין (Search)")
                .addText("מעיינות, מעברי 4x4, חניונים ונקודות אישיות")
                .setImage(carIcon(ctx, R.drawable.ic_car_search), Row.IMAGE_TYPE_ICON)
                .setBrowsable(true)
                .setOnClickListener(() -> getScreenManager().push(new CarSearchScreen(ctx, session, null)))
                .build()
        );

        String routeSubtitle = routes.isEmpty()
            ? "אין מסלולים מסונכרנים — פתח/י מסלול בטלפון"
            : routes.size() + " מסלולים זמינים לניווט שטח";
        list.addItem(
            new Row.Builder()
                .setTitle("מסלולים שמורים וצירים")
                .addText(routeSubtitle)
                .setImage(carIcon(ctx, R.drawable.ic_car_routes), Row.IMAGE_TYPE_ICON)
                .setBrowsable(true)
                .setOnClickListener(() -> getScreenManager().push(new CarRoutesScreen(ctx, session)))
                .build()
        );

        list.addItem(
            new Row.Builder()
                .setTitle("מים ומעיינות קרובים")
                .addText("גבים, מעיינות וברזי מים לפי מרחק")
                .setImage(carIcon(ctx, R.drawable.ic_car_water), Row.IMAGE_TYPE_ICON)
                .setBrowsable(true)
                .setOnClickListener(() -> getScreenManager().push(new CarSearchScreen(ctx, session, "water")))
                .build()
        );

        list.addItem(
            new Row.Builder()
                .setTitle("אתגרי עבירות ו-4x4 קרובים")
                .addText("מעלות, נקודות קושי וחסימות ציר")
                .setImage(carIcon(ctx, R.drawable.ic_car_offroad), Row.IMAGE_TYPE_ICON)
                .setBrowsable(true)
                .setOnClickListener(() -> getScreenManager().push(new CarSearchScreen(ctx, session, "offroad")))
                .build()
        );

        list.addItem(
            new Row.Builder()
                .setTitle("חניוני לילה, תצפיות ואישיות")
                .addText("לינת שטח, נקודות חן וסימוני משתמש (" + store.countUserPois() + ")")
                .setImage(carIcon(ctx, R.drawable.ic_car_camp), Row.IMAGE_TYPE_ICON)
                .setBrowsable(true)
                .setOnClickListener(() -> getScreenManager().push(new CarSearchScreen(ctx, session, "campsite")))
                .build()
        );

        list.addItem(
            new Row.Builder()
                .setTitle("תצוגה: " + modeLabel)
                .addText(offlineSummary)
                .setImage(carIcon(ctx, R.drawable.ic_car_layers), Row.IMAGE_TYPE_ICON)
                .setOnClickListener(() -> {
                    String nextLabel = session.cycleVisualMode();
                    CarToast.makeText(ctx, nextLabel, CarToast.LENGTH_SHORT).show();
                    invalidate();
                })
                .build()
        );

        Header header = new Header.Builder()
            .setStartHeaderAction(Action.BACK)
            .setTitle("NavApp שטח")
            .addEndHeaderAction(
                new Action.Builder()
                    .setIcon(carIcon(ctx, R.drawable.ic_car_heritage))
                    .setOnClickListener(() -> getScreenManager().push(new CarSearchScreen(ctx, session, "heritage")))
                    .build()
            )
            .build();

        return new ListTemplate.Builder()
            .setHeader(header)
            .setSingleList(list.build())
            .build();
    }

    private static CarIcon carIcon(CarContext ctx, int resId) {
        return new CarIcon.Builder(IconCompat.createWithResource(ctx, resId)).build();
    }
}
