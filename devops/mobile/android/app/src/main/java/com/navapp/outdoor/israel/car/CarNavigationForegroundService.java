package com.navapp.outdoor.israel.car;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.navapp.outdoor.israel.MainActivity;
import com.navapp.outdoor.israel.R;

/**
 * Foreground location service active during Android Auto offroad/trail navigation so GNSS
 * location updates remain reliable when the phone screen locks or rests in the vehicle cabin.
 */
public final class CarNavigationForegroundService extends Service {
    private static final String TAG = "CarNavFgService";
    private static final String CHANNEL_ID = "navapp_car_navigation";
    private static final int NOTIFICATION_ID = 4401;

    public static final String ACTION_START = "com.navapp.outdoor.israel.car.START_NAV";
    public static final String ACTION_STOP = "com.navapp.outdoor.israel.car.STOP_NAV";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_SUBTITLE = "subtitle";

    public static void startOrUpdate(Context context, String title, String subtitle) {
        if (context == null) return;
        try {
            Intent intent = new Intent(context, CarNavigationForegroundService.class);
            intent.setAction(ACTION_START);
            intent.putExtra(EXTRA_TITLE, title != null ? title : "NavApp ניווט שטח");
            intent.putExtra(EXTRA_SUBTITLE, subtitle != null ? subtitle : "ניווט פעיל ב-Android Auto");
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception ex) {
            Log.w(TAG, "Unable to start foreground navigation service", ex);
        }
    }

    public static void stop(Context context) {
        if (context == null) return;
        try {
            Intent intent = new Intent(context, CarNavigationForegroundService.class);
            intent.setAction(ACTION_STOP);
            context.stopService(intent);
        } catch (Exception ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean fineGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
        boolean coarseGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
        if (!fineGranted && !coarseGranted) {
            Log.w(TAG, "Location permission not granted; skipping location foreground service.");
            stopSelf();
            return START_NOT_STICKY;
        }

        ensureNotificationChannel();
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String subtitle = intent != null ? intent.getStringExtra(EXTRA_SUBTITLE) : null;
        if (title == null || title.trim().isEmpty()) {
            title = "NavApp — ניווט ב-Android Auto";
        }
        if (subtitle == null || subtitle.trim().isEmpty()) {
            subtitle = "מעקב GPS פעיל";
        }

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, piFlags);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_car_compass)
            .setContentTitle(title)
            .setContentText(subtitle)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(contentIntent)
            .build();

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (SecurityException ex) {
            Log.w(TAG, "Foreground location start blocked by OS policy", ex);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            //noinspection deprecation
            stopForeground(true);
        }
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "ניווט Android Auto",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("התראת ניווט פעיל ומעקב GPS בעת חיבור ל-Android Auto");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
