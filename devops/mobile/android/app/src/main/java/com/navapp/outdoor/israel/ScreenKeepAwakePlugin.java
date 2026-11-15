package com.navapp.outdoor.israel;

import android.app.Activity;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenKeepAwake")
public class ScreenKeepAwakePlugin extends Plugin {

    @PluginMethod
    public void keepAwake(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() ->
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            );
        }
        call.resolve();
    }

    @PluginMethod
    public void allowSleep(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() ->
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            );
        }
        call.resolve();
    }
}
