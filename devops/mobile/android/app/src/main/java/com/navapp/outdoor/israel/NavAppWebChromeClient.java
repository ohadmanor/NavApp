package com.navapp.outdoor.israel;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Message;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.Locale;

/**
 * Custom BridgeWebChromeClient that preserves all Capacitor Chrome callbacks (permissions, file
 * chooser, alerts) while opening JS `window.open(...)` popups (such as Firebase Auth
 * `signInWithPopup` -> `/__/auth/handler` and external `_blank` links) inside a dedicated,
 * cancellable modal Dialog WebView instead of replacing the main `https://localhost/` WebView.
 */
public class NavAppWebChromeClient extends BridgeWebChromeClient {
    private final Bridge hostBridge;
    private final Activity hostActivity;

    public NavAppWebChromeClient(Bridge bridge, Activity activity) {
        super(bridge);
        this.hostBridge = bridge;
        this.hostActivity = activity;
    }

    private int dp(int value) {
        return Math.round(
            TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP,
                value,
                hostActivity.getResources().getDisplayMetrics()
            )
        );
    }

    @Override
    public boolean onCreateWindow(
        WebView view,
        boolean isDialog,
        boolean isUserGesture,
        Message resultMsg
    ) {
        if (resultMsg == null || !(resultMsg.obj instanceof WebView.WebViewTransport)) {
            return false;
        }
        Activity activity = hostBridge != null && hostBridge.getActivity() != null
            ? hostBridge.getActivity()
            : hostActivity;
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            return false;
        }

        final Dialog dialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setCancelable(true);

        final LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0f172a"));
        root.setLayoutParams(
            new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime()
            );
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });

        // Header Bar with Title + Explicit Close Button
        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setBackgroundColor(Color.parseColor("#0f172a"));
        int padH = dp(12);
        int padV = dp(8);
        header.setPadding(padH, padV, padH, padV);
        header.setLayoutParams(
            new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        );

        final TextView titleView = new TextView(activity);
        titleView.setText("התחברות לחשבון Google");
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        );
        titleView.setLayoutParams(titleLp);

        TextView closeBtn = new TextView(activity);
        closeBtn.setText("✕ סגור");
        closeBtn.setTextColor(Color.parseColor("#e2e8f0"));
        closeBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        closeBtn.setPadding(dp(12), dp(6), dp(12), dp(6));
        closeBtn.setBackgroundColor(Color.parseColor("#1e293b"));
        closeBtn.setClickable(true);
        closeBtn.setFocusable(true);

        header.addView(titleView);
        header.addView(closeBtn);
        root.addView(header);

        final ProgressBar progressBar = new ProgressBar(
            activity,
            null,
            android.R.attr.progressBarStyleHorizontal
        );
        progressBar.setMax(100);
        progressBar.setIndeterminate(false);
        progressBar.setLayoutParams(
            new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(3))
        );
        root.addView(progressBar);

        final WebView popupWebView = new WebView(activity);
        popupWebView.setLayoutParams(
            new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        );

        WebSettings settings = popupWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(popupWebView, true);

        root.addView(popupWebView);
        dialog.setContentView(root);

        Window dialogWindow = dialog.getWindow();
        if (dialogWindow != null) {
            dialogWindow.setBackgroundDrawable(new ColorDrawable(Color.parseColor("#0f172a")));
            dialogWindow.setLayout(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            );
            dialogWindow.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }

        final boolean[] closed = new boolean[] { false };
        final Runnable closePopup = () -> {
            if (closed[0]) return;
            closed[0] = true;
            try {
                CookieManager.getInstance().flush();
            } catch (Throwable ignored) {}
            try {
                if (dialog.isShowing()) {
                    dialog.dismiss();
                }
            } catch (Throwable ignored) {}
            try {
                ViewGroup parent = (ViewGroup) popupWebView.getParent();
                if (parent != null) {
                    parent.removeView(popupWebView);
                }
                popupWebView.stopLoading();
                popupWebView.loadUrl("about:blank");
                popupWebView.clearHistory();
                popupWebView.destroy();
            } catch (Throwable ignored) {}
        };

        closeBtn.setOnClickListener(v -> closePopup.run());
        dialog.setOnDismissListener(d -> closePopup.run());
        dialog.setOnKeyListener((d, keyCode, event) -> {
            if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
                if (!closed[0] && popupWebView.canGoBack()) {
                    popupWebView.goBack();
                } else {
                    closePopup.run();
                }
                return true;
            }
            return false;
        });

        popupWebView.setWebViewClient(
            new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                    if (request == null || request.getUrl() == null) return false;
                    return handlePopupNavigation(activity, request.getUrl(), closePopup);
                }

                @Override
                @SuppressWarnings("deprecation")
                public boolean shouldOverrideUrlLoading(WebView v, String url) {
                    if (url == null) return false;
                    return handlePopupNavigation(activity, Uri.parse(url), closePopup);
                }
            }
        );

        popupWebView.setWebChromeClient(
            new WebChromeClient() {
                @Override
                public void onCloseWindow(WebView window) {
                    closePopup.run();
                }

                @Override
                public void onProgressChanged(WebView v, int newProgress) {
                    progressBar.setProgress(newProgress);
                    progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
                }

                @Override
                public void onReceivedTitle(WebView v, String title) {
                    if (
                        title != null &&
                        !title.trim().isEmpty() &&
                        !title.startsWith("http://") &&
                        !title.startsWith("https://")
                    ) {
                        titleView.setText(title.trim());
                    }
                }
            }
        );

        dialog.show();

        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
        transport.setWebView(popupWebView);
        resultMsg.sendToTarget();
        return true;
    }

    private static boolean handlePopupNavigation(Activity activity, Uri uri, Runnable closePopup) {
        if (uri == null || uri.getScheme() == null) return false;
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";

        // Never render the Capacitor app itself inside the popup dialog
        if (("https".equals(scheme) || "http".equals(scheme)) &&
            ("localhost".equals(host) || "127.0.0.1".equals(host))) {
            closePopup.run();
            return true;
        }

        if ("http".equals(scheme) || "https".equals(scheme)) {
            return false;
        }

        if ("intent".equals(scheme)) {
            try {
                Intent intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                if (intent != null) {
                    if (intent.resolveActivity(activity.getPackageManager()) != null) {
                        activity.startActivity(intent);
                        return true;
                    }
                    String fallbackUrl = intent.getStringExtra("browser_fallback_url");
                    if (fallbackUrl != null && !fallbackUrl.isEmpty()) {
                        return false;
                    }
                }
            } catch (Throwable ignored) {}
            return true;
        }

        try {
            Intent viewIntent = new Intent(Intent.ACTION_VIEW, uri);
            activity.startActivity(viewIntent);
        } catch (Throwable ignored) {}
        return true;
    }
}
