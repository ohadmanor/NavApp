package com.navapp.outdoor.israel.car;

import android.content.pm.ApplicationInfo;
import androidx.annotation.NonNull;
import androidx.car.app.CarAppService;
import androidx.car.app.Session;
import androidx.car.app.SessionInfo;
import androidx.car.app.validation.HostValidator;

/**
 * Entry point service bound by the Android Auto projected host (`com.google.android.projection.gearhead`)
 * and Google's Desktop Head Unit (DHU).
 */
public final class NavCarAppService extends CarAppService {
    @NonNull
    @Override
    public HostValidator createHostValidator() {
        boolean isDebuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (isDebuggable) {
            return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR;
        }
        return new HostValidator.Builder(getApplicationContext())
            .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
            .build();
    }

    @NonNull
    @Override
    public Session onCreateSession() {
        return new NavCarSession();
    }

    @NonNull
    @Override
    public Session onCreateSession(@NonNull SessionInfo sessionInfo) {
        return new NavCarSession();
    }
}
