package com.navapp.outdoor.israel.car;

import androidx.annotation.NonNull;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.constraints.ConstraintManager;
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
import java.util.Locale;

/**
 * Lists saved routes synced from the phone app, letting the driver pick a route
 * to display on the car map and start live trail/off-route navigation.
 */
public final class CarRoutesScreen extends Screen {
    private final NavCarSession session;

    public CarRoutesScreen(@NonNull CarContext carContext, @NonNull NavCarSession session) {
        super(carContext);
        this.session = session;
    }

    @NonNull
    @Override
    public Template onGetTemplate() {
        CarContext ctx = getCarContext();
        List<NativeMapStore.CarRoute> routes = session.getSavedRoutes();
        NativeMapStore.CarRoute active = session.getActiveRoute();

        int maxItems = 6;
        try {
            ConstraintManager cm = ctx.getCarService(ConstraintManager.class);
            maxItems = Math.max(6, cm.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST));
        } catch (Exception ignored) {
        }

        ItemList.Builder list = new ItemList.Builder()
            .setNoItemsMessage("אין מסלולים שמורים. פתח/י או תכנן/י מסלול באפליקציה בטלפון.");

        int limit = Math.min(routes.size(), maxItems);
        for (int i = 0; i < limit; i++) {
            NativeMapStore.CarRoute r = routes.get(i);
            boolean isActive = active != null && r.id.equals(active.id);
            String title = isActive ? ("★ " + r.name) : r.name;
            String stats = String.format(
                Locale.US,
                "%.1f ק״מ  •  ↑%d מ׳  ↓%d מ׳",
                r.distanceKm,
                r.ascentMeters,
                r.descentMeters
            );
            list.addItem(
                new Row.Builder()
                    .setTitle(title)
                    .addText(stats)
                    .setImage(carIcon(ctx, R.drawable.ic_car_routes), Row.IMAGE_TYPE_ICON)
                    .setOnClickListener(() -> session.selectRouteAndNavigate(r))
                    .build()
            );
        }

        Header header = new Header.Builder()
            .setStartHeaderAction(Action.BACK)
            .setTitle("מסלולים שמורים")
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
