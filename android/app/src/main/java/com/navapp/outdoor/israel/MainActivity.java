package com.navapp.outdoor.israel;

import android.os.Build;
import android.os.Bundle;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScreenKeepAwakePlugin.class);
        registerPlugin(NativeGpsPlugin.class);
        registerPlugin(NativeOfflineStoragePlugin.class);
        super.onCreate(savedInstanceState);
        NativeMapStore.getInstance(this).ensurePoisLoadedAsync();
        LocalCarServer.getInstance(this).ensureStarted();
    }

    @Override
    protected void load() {
        super.load();
        if (bridge == null) return;
        bridge.setWebViewClient(new NavAppWebViewClient(bridge, this));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                ServiceWorkerController swController = ServiceWorkerController.getInstance();
                swController.setServiceWorkerClient(
                    new ServiceWorkerClient() {
                        @Override
                        public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                            WebResourceResponse nativeResp =
                                NavAppWebViewClient.maybeInterceptNativeMapRequest(MainActivity.this, request);
                            if (nativeResp != null) {
                                return nativeResp;
                            }
                            return bridge.getLocalServer().shouldInterceptRequest(request);
                        }
                    }
                );
            } catch (Throwable ignored) {
                // ServiceWorkerController may not exist on customized Android System WebViews
            }
        }
    }
}
