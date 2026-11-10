package com.navapp.outdoor.israel;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenKeepAwakePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
