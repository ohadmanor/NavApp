package com.navapp.outdoor.israel.car;

import androidx.annotation.NonNull;
import androidx.car.app.CarContext;
import androidx.car.app.CarToast;
import androidx.car.app.Screen;
import androidx.car.app.model.Action;
import androidx.car.app.model.ActionStrip;
import androidx.car.app.model.CarColor;
import androidx.car.app.model.CarIcon;
import androidx.car.app.model.DateTimeWithZone;
import androidx.car.app.model.Distance;
import androidx.car.app.model.Template;
import androidx.car.app.navigation.model.Maneuver;
import androidx.car.app.navigation.model.MessageInfo;
import androidx.car.app.navigation.model.NavigationTemplate;
import androidx.car.app.navigation.model.RoutingInfo;
import androidx.car.app.navigation.model.Step;
import androidx.car.app.navigation.model.TravelEstimate;
import androidx.core.graphics.drawable.IconCompat;
import com.navapp.outdoor.israel.R;
import java.util.TimeZone;

/**
 * Primary full-screen Android Auto NavigationTemplate displaying the live MapLibre Native
 * Israel Hiking / Topo / Satellite map, HUD routing card, orientation toggle, and pan/zoom strip.
 */
public final class NavCarMapScreen extends Screen {
    private final NavCarSession session;

    public NavCarMapScreen(@NonNull CarContext carContext, @NonNull NavCarSession session) {
        super(carContext);
        this.session = session;
    }

    @NonNull
    @Override
    public Template onGetTemplate() {
        CarContext ctx = getCarContext();
        CarMapController map = session.getMapController();
        CarNavLocationTracker.NavTelemetry t = session.getLatestTelemetry();

        boolean headingUp = map.getOrientationMode() == CarMapController.OrientationMode.HEADING_UP;
        boolean navigating = session.isNavigating();

        // 1. Primary ActionStrip (max 4 icon actions)
        Action menuAction = new Action.Builder()
            .setIcon(carIcon(ctx, R.drawable.ic_car_routes))
            .setOnClickListener(() -> getScreenManager().push(new CarMenuScreen(ctx, session)))
            .build();

        Action layerCycleAction = new Action.Builder()
            .setIcon(carIcon(ctx, R.drawable.ic_car_layers))
            .setOnClickListener(() -> {
                String label = session.cycleVisualMode();
                CarToast.makeText(ctx, label, CarToast.LENGTH_SHORT).show();
            })
            .build();

        Action compassAction = new Action.Builder()
            .setIcon(carIcon(ctx, headingUp ? R.drawable.ic_car_compass : R.drawable.ic_car_north))
            .setOnClickListener(() -> {
                map.toggleOrientationMode();
                invalidate();
            })
            .build();

        ActionStrip.Builder topStrip = new ActionStrip.Builder()
            .addAction(menuAction)
            .addAction(layerCycleAction)
            .addAction(compassAction);

        if (navigating) {
            Action stopAction = new Action.Builder()
                .setIcon(carIcon(ctx, R.drawable.ic_car_stop))
                .setOnClickListener(session::stopNavigation)
                .build();
            topStrip.addAction(stopAction);
        } else {
            Action searchAction = new Action.Builder()
                .setIcon(carIcon(ctx, R.drawable.ic_car_search))
                .setOnClickListener(() -> getScreenManager().push(new CarSearchScreen(ctx, session, null)))
                .build();
            topStrip.addAction(searchAction);
        }

        NavigationTemplate.Builder builder = new NavigationTemplate.Builder()
            .setActionStrip(topStrip.build());

        if (ctx.getCarAppApiLevel() >= 2) {
            // 2. Map ActionStrip (4 icon-only controls matching ACTIONS_CONSTRAINTS_MAP, Car API 2+)
            ActionStrip mapStrip = new ActionStrip.Builder()
                .addAction(Action.PAN)
                .addAction(
                    new Action.Builder()
                        .setIcon(carIcon(ctx, R.drawable.ic_car_recenter))
                        .setOnClickListener(() -> {
                            map.recenter();
                            invalidate();
                        })
                        .build()
                )
                .addAction(
                    new Action.Builder()
                        .setIcon(carIcon(ctx, R.drawable.ic_car_zoom_in))
                        .setOnClickListener(map::zoomIn)
                        .build()
                )
                .addAction(
                    new Action.Builder()
                        .setIcon(carIcon(ctx, R.drawable.ic_car_zoom_out))
                        .setOnClickListener(map::zoomOut)
                        .build()
                )
                .build();

            builder
                .setMapActionStrip(mapStrip)
                .setPanModeListener(isPanMode -> {
                    map.setPanMode(isPanMode);
                    invalidate();
                });
        }

        // 3. Optional Navigation HUD / Permission Prompt Card
        if (t != null && !t.hasLocationPermission) {
            MessageInfo permMsg = new MessageInfo.Builder("נדרשת הרשאת מיקום")
                .setText("יש לאשר גישה למיקום באפליקציה בטלפון להצגת מיקום והכוונה")
                .setImage(carIcon(ctx, R.drawable.ic_car_compass))
                .build();
            builder.setNavigationInfo(permMsg);
        } else if (navigating && t != null && t.hasActiveRoute) {
            Distance stepDist = NavCarSession.formatCarDistance(t.nextManeuverDistanceMeters);
            Distance destDist = NavCarSession.formatCarDistance(t.remainingDistanceMeters);

            Maneuver maneuver = new Maneuver.Builder(t.nextManeuverType).build();
            String cue = (t.nextStepCue == null || t.nextStepCue.isEmpty())
                ? (t.destinationName.isEmpty() ? "ניווט בשטח" : t.destinationName)
                : t.nextStepCue;
            Step step = new Step.Builder(cue)
                .setManeuver(maneuver)
                .build();

            RoutingInfo routingInfo = new RoutingInfo.Builder()
                .setCurrentStep(step, stepDist)
                .build();

            long etaSec = Math.max(0L, t.etaSeconds);
            long arrivalMs = System.currentTimeMillis() + (etaSec * 1000L);
            TravelEstimate destEstimate = new TravelEstimate.Builder(
                destDist,
                DateTimeWithZone.create(arrivalMs, TimeZone.getDefault())
            )
                .setRemainingTimeSeconds(etaSec)
                .build();

            builder
                .setNavigationInfo(routingInfo)
                .setDestinationTravelEstimate(destEstimate)
                .setBackgroundColor(t.isOffRoute ? CarColor.RED : CarColor.GREEN);
        }

        return builder.build();
    }

    private static CarIcon carIcon(CarContext ctx, int resId) {
        return new CarIcon.Builder(IconCompat.createWithResource(ctx, resId)).build();
    }
}
