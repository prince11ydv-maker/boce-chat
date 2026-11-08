package app.classnest.pusoe;

import android.app.Activity;
import android.app.AlertDialog;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/** Native Android client for the trusted, same-origin Classnest application. */
public final class MainActivity extends Activity {
    private static final int FILE_PICKER = 2204;
    private static final int PHONE_ALERT_PERMISSION = 2205;
    private static final int BRAND = Color.rgb(69, 69, 154);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<WebView> pendingPopups = new ArrayList<>();
    private WebView webView;
    private FrameLayout browserFrame;
    private LinearLayout root, errorPanel;
    private TextView errorTitle, errorMessage;
    private ProgressBar loading;
    private AttachmentDownloads downloads;
    private ValueCallback<Uri[]> selectedFiles;
    private boolean allowMultipleFiles, destroyed, failed, backPending;
    private OnBackInvokedCallback backCallback;
    private final Runnable pushSync = new Runnable() {
        @Override public void run() {
            if (destroyed) return;
            NativePush.synchronize(MainActivity.this, false);
            mainHandler.postDelayed(this, 30000);
        }
    };
    private final Runnable loadTimeout = () -> {
        if (!destroyed && loading != null && loading.getVisibility() == View.VISIBLE) {
            if (webView != null) webView.stopLoading();
            showError("Your class is taking a little longer", "Check your internet connection, then try again.");
        }
    };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(BRAND);
        getWindow().setNavigationBarColor(BRAND);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        NativePush.createChannel(this);
        buildNativeLayout();
        createWebView();
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null
            || !UrlPolicy.isFirstParty(webView.getUrl())) {
            webView.loadUrl(UrlPolicy.HOME);
        }
        openNotification(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openNotification(intent);
    }

    private void openNotification(Intent intent) {
        if (intent == null || !"CLASSNEST_NOTIFICATION".equals(intent.getAction()) || webView == null) return;
        String destination = UrlPolicy.notificationDestination(intent.getStringExtra("url"));
        webView.loadUrl(destination == null ? UrlPolicy.ORIGIN + "/#notifications" : destination);
        // A later orientation change must not reopen a previously consumed alert.
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra("url");
    }

    private void buildNativeLayout() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BRAND);
        root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = windowInsets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets keyboard = windowInsets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return WindowInsets.CONSUMED;
            }
            int left = windowInsets.getSystemWindowInsetLeft(), top = windowInsets.getSystemWindowInsetTop();
            int right = windowInsets.getSystemWindowInsetRight(), bottom = windowInsets.getSystemWindowInsetBottom();
            if (Build.VERSION.SDK_INT >= 28 && windowInsets.getDisplayCutout() != null) {
                left = Math.max(left, windowInsets.getDisplayCutout().getSafeInsetLeft());
                top = Math.max(top, windowInsets.getDisplayCutout().getSafeInsetTop());
                right = Math.max(right, windowInsets.getDisplayCutout().getSafeInsetRight());
                bottom = Math.max(bottom, windowInsets.getDisplayCutout().getSafeInsetBottom());
                windowInsets = windowInsets.consumeDisplayCutout();
            }
            view.setPadding(left, top, right, bottom);
            return windowInsets.consumeSystemWindowInsets();
        });

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(16), 0, dp(8), 0);
        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextSize(20);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setTextColor(Color.WHITE);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        title.setGravity(Gravity.CENTER_VERTICAL);
        ImageButton menu = new ImageButton(this);
        menu.setImageResource(android.R.drawable.ic_menu_more);
        menu.setImageTintList(ColorStateList.valueOf(Color.WHITE));
        menu.setBackgroundColor(Color.TRANSPARENT);
        menu.setContentDescription("App menu");
        menu.setOnClickListener(view -> showAppMenu(menu));
        toolbar.addView(menu, new LinearLayout.LayoutParams(dp(48), dp(48)));
        root.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        loading = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loading.setMax(100);
        loading.setProgressTintList(ColorStateList.valueOf(Color.rgb(223, 255, 153)));
        loading.setContentDescription("Loading Classnest");
        root.addView(loading, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));
        browserFrame = new FrameLayout(this);
        browserFrame.setBackgroundColor(backgroundColor());
        root.addView(browserFrame, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(dp(28), dp(24), dp(28), dp(24));
        errorPanel.setBackgroundColor(backgroundColor());
        errorTitle = new TextView(this);
        errorTitle.setTextSize(25);
        errorTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        errorTitle.setTextColor(textColor());
        errorTitle.setGravity(Gravity.CENTER);
        if (Build.VERSION.SDK_INT >= 28) errorTitle.setAccessibilityHeading(true);
        errorPanel.addView(errorTitle, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        errorMessage = new TextView(this);
        errorMessage.setTextSize(16);
        errorMessage.setTextColor(textColor());
        errorMessage.setGravity(Gravity.CENTER);
        errorMessage.setPadding(0, dp(14), 0, dp(22));
        errorPanel.addView(errorMessage);
        Button retry = new Button(this);
        retry.setText(R.string.try_again);
        retry.setMinHeight(dp(48));
        retry.setOnClickListener(view -> reloadPage());
        errorPanel.addView(retry);
        Button browser = new Button(this);
        browser.setText(R.string.open_website);
        browser.setMinHeight(dp(48));
        browser.setOnClickListener(view -> openExternal(UrlPolicy.ORIGIN));
        errorPanel.addView(browser);
        errorPanel.setVisibility(View.GONE);
        setContentView(root);
        root.requestApplyInsets();
    }

    @SuppressWarnings("deprecation") private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(backgroundColor());
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSaveFormData(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUserAgentString(settings.getUserAgentString() + " ClassnestAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        if (downloads != null) downloads.close();
        downloads = new AttachmentDownloads(this, settings.getUserAgentString());
        webView.setDownloadListener((url, userAgent, disposition, mime, size) -> {
            if (UrlPolicy.isFirstParty(webView.getUrl())) downloads.start(url);
        });
        webView.setWebViewClient(new TrustedBrowserClient());
        webView.setWebChromeClient(new ChromeClient());
        browserFrame.addView(webView, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (errorPanel.getParent() == null) browserFrame.addView(errorPanel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        errorPanel.bringToFront();
    }

    private final class TrustedBrowserClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return request.isForMainFrame() && routeNavigation(request.getUrl().toString(), request.hasGesture(), false);
        }

        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (!UrlPolicy.isFirstParty(url)) {
                view.stopLoading();
                showError("This page cannot open in Classnest", "Use the app menu to open the website in your browser.");
                return;
            }
            failed = false;
            errorPanel.setVisibility(View.GONE);
            view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            loading.setProgress(0);
            loading.setVisibility(View.VISIBLE);
            mainHandler.removeCallbacks(loadTimeout);
            mainHandler.postDelayed(loadTimeout, 30000);
        }

        @Override public void onPageFinished(WebView view, String url) {
            mainHandler.removeCallbacks(loadTimeout);
            loading.setVisibility(View.GONE);
            CookieManager.getInstance().flush();
            NativePush.synchronize(MainActivity.this, false);
            if (!failed && UrlPolicy.isFirstParty(url)) errorPanel.setVisibility(View.GONE);
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError("Your class is offline for a moment", "Connect to the internet to read the latest notes and class updates, then try again.");
        }

        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame()) showError("Classnest is temporarily unavailable", "Please try again in a moment. Your account and class content remain on Classnest.");
        }

        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            showError("A secure connection is unavailable", "Check your connection and your phone’s date and time, then try again.");
        }

        @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            mainHandler.removeCallbacks(loadTimeout);
            browserFrame.removeView(view);
            view.destroy();
            createWebView();
            showError("Classnest needs a fresh start", "Tap Try again to reopen your class.");
            return true;
        }
    }

    private final class ChromeClient extends WebChromeClient {
        @Override public void onProgressChanged(WebView view, int progress) {
            loading.setProgress(progress);
            if (progress >= 100) loading.setVisibility(View.GONE);
        }

        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            cancelFileSelection();
            if (!UrlPolicy.isFirstParty(view.getUrl()) || (params.getMode() != FileChooserParams.MODE_OPEN
                && params.getMode() != FileChooserParams.MODE_OPEN_MULTIPLE)) return false;
            selectedFiles = callback;
            allowMultipleFiles = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultipleFiles);
            String[] accepted = acceptedMimes(params.getAcceptTypes());
            if (accepted.length == 1) intent.setType(accepted[0]);
            else if (accepted.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, accepted);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { startActivityForResult(intent, FILE_PICKER); }
            catch (ActivityNotFoundException ignored) {
                cancelFileSelection();
                Toast.makeText(MainActivity.this, "No file picker is available on this phone.", Toast.LENGTH_LONG).show();
            }
            return true;
        }

        @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message resultMsg) {
            if (!userGesture || !UrlPolicy.isFirstParty(view.getUrl())) return false;
            // A disposable popup has no JavaScript, network or local-file access,
            // native interface, or visible surface. Its first URL is routed
            // through exactly the same policy as an ordinary tapped link.
            WebView popup = new WebView(MainActivity.this);
            WebSettings settings = popup.getSettings();
            settings.setJavaScriptEnabled(false);
            settings.setBlockNetworkLoads(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setSafeBrowsingEnabled(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(popup, false);
            pendingPopups.add(popup);
            popup.setWebViewClient(new WebViewClient() {
                private boolean routed;
                private void route(String url) {
                    if (routed || "about:blank".equals(url)) return;
                    routed = true;
                    routeNavigation(url, true, true);
                    mainHandler.post(() -> disposePopup(popup));
                }
                @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                    if (request.isForMainFrame()) route(request.getUrl().toString());
                    return true;
                }
                @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                    if (!"about:blank".equals(url)) { v.stopLoading(); route(url); }
                }
                @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
                    mainHandler.post(() -> disposePopup(v));
                    return true;
                }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popup);
            resultMsg.sendToTarget();
            mainHandler.postDelayed(() -> disposePopup(popup), 10000);
            return true;
        }
    }

    private boolean routeNavigation(String url, boolean userGesture, boolean fromPopup) {
        if (UrlPolicy.isDownloadSource(url)) {
            if (userGesture) downloads.start(url);
            return true;
        }
        if (UrlPolicy.isFirstParty(url)) {
            if (fromPopup) webView.loadUrl(url);
            return fromPopup;
        }
        if (userGesture && (UrlPolicy.isExternalHttps(url) || UrlPolicy.isMailTo(url))) {
            openExternal(url);
        } else if (userGesture) {
            Toast.makeText(this, "This link is not supported in Classnest.", Toast.LENGTH_LONG).show();
        }
        return true;
    }

    private void disposePopup(WebView popup) {
        if (pendingPopups.remove(popup)) {
            popup.stopLoading();
            popup.destroy();
        }
    }

    private String[] acceptedMimes(String[] acceptedTypes) {
        LinkedHashSet<String> types = new LinkedHashSet<>();
        for (String group : acceptedTypes) {
            for (String entry : group.split(",")) {
                String type = entry.trim().toLowerCase(Locale.ROOT);
                if (type.startsWith(".")) type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.substring(1));
                if (type != null && type.matches("[a-z0-9.+-]+/(?:[a-z0-9.+-]+|\\*)")) types.add(type);
            }
        }
        return types.toArray(new String[0]);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_PICKER || selectedFiles == null) return;
        ValueCallback<Uri[]> callback = selectedFiles;
        selectedFiles = null;
        if (resultCode != RESULT_OK || data == null) { callback.onReceiveValue(null); return; }
        LinkedHashSet<Uri> values = new LinkedHashSet<>();
        ClipData clips = data.getClipData();
        if (clips != null) {
            if (clips.getItemCount() > (allowMultipleFiles ? 10 : 1)) { callback.onReceiveValue(null); return; }
            for (int i = 0; i < clips.getItemCount(); i++) values.add(clips.getItemAt(i).getUri());
        } else if (data.getData() != null) values.add(data.getData());
        for (Uri uri : values) {
            if (uri == null || !"content".equalsIgnoreCase(uri.getScheme()) || uri.getAuthority() == null
                || uri.toString().length() > 8192) {
                callback.onReceiveValue(null);
                Toast.makeText(this, "Choose a file through your phone’s document picker.", Toast.LENGTH_LONG).show();
                return;
            }
        }
        callback.onReceiveValue(values.isEmpty() ? null : values.toArray(new Uri[0]));
    }

    private void cancelFileSelection() {
        if (selectedFiles != null) {
            ValueCallback<Uri[]> callback = selectedFiles;
            selectedFiles = null;
            callback.onReceiveValue(null);
        }
    }

    private void showAppMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add(0, 1, 0, "Reload Classnest");
        menu.getMenu().add(0, 2, 1, "Open in browser");
        menu.getMenu().add(0, 3, 2, "Share Classnest");
        menu.getMenu().add(0, 4, 3, "About Classnest");
        menu.getMenu().add(0, 5, 4, NativePush.enabled(this) ? R.string.phone_alert_disable : R.string.phone_alert_enable);
        menu.setOnMenuItemClickListener(item -> {
            if (item.getItemId() == 1) new AlertDialog.Builder(this).setTitle("Reload Classnest?")
                .setMessage("Finish or save any changes before reloading.").setNegativeButton("Keep working", null)
                .setPositiveButton("Reload", (dialog, which) -> reloadPage()).show();
            if (item.getItemId() == 2) openExternal(UrlPolicy.ORIGIN);
            if (item.getItemId() == 3) {
                Intent share = new Intent(Intent.ACTION_SEND);
                share.setType("text/plain");
                share.putExtra(Intent.EXTRA_TEXT, "Classnest · Your class, connected\n" + UrlPolicy.ORIGIN);
                startActivity(Intent.createChooser(share, "Share Classnest"));
            }
            if (item.getItemId() == 4) new AlertDialog.Builder(this).setTitle("Classnest")
                .setMessage("Your class, connected.\n\nUse your existing Classnest account to share notes and keep up with class. An internet connection is needed for current content.\n\nVersion " + BuildConfig.VERSION_NAME)
                .setPositiveButton("Done", null).show();
            if (item.getItemId() == 5) {
                if (NativePush.enabled(this)) NativePush.disable(this);
                else new AlertDialog.Builder(this).setTitle(R.string.phone_alert_enable)
                    .setMessage("Get phone alerts for new notes, announcements, and class updates, even when Classnest is closed. Open the app to read the details. You can turn alerts off from this menu.")
                    .setNegativeButton("Not now", null)
                    .setPositiveButton("Continue", (dialog, which) -> requestPhoneAlerts()).show();
            }
            return true;
        });
        menu.show();
    }

    private void requestPhoneAlerts() {
        if (!NativePush.configured(this)) { Toast.makeText(this, R.string.phone_alert_unavailable, Toast.LENGTH_LONG).show(); return; }
        if (NativePush.sessionCookie().isEmpty()) { Toast.makeText(this, R.string.phone_alert_sign_in, Toast.LENGTH_LONG).show(); return; }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PHONE_ALERT_PERMISSION);
            return;
        }
        if (!NativePush.permissionGranted(this)) {
            Toast.makeText(this, R.string.phone_alert_permission, Toast.LENGTH_LONG).show();
            Intent settings = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            try { startActivity(settings); } catch (ActivityNotFoundException ignored) { }
            return;
        }
        NativePush.enable(this);
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != PHONE_ALERT_PERMISSION) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) NativePush.enable(this);
        else Toast.makeText(this, R.string.phone_alert_permission, Toast.LENGTH_LONG).show();
    }

    private void openExternal(String url) {
        if (!UrlPolicy.isFirstParty(url) && !UrlPolicy.isExternalHttps(url) && !UrlPolicy.isMailTo(url)) return;
        Intent intent = new Intent(UrlPolicy.isMailTo(url) ? Intent.ACTION_SENDTO : Intent.ACTION_VIEW, Uri.parse(url));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try { startActivity(intent); }
        catch (ActivityNotFoundException ignored) { Toast.makeText(this, "No app can open this link.", Toast.LENGTH_LONG).show(); }
    }

    private void reloadPage() {
        if (webView == null || destroyed) return;
        failed = false;
        errorPanel.setVisibility(View.GONE);
        if (UrlPolicy.isFirstParty(webView.getUrl())) webView.reload();
        else webView.loadUrl(UrlPolicy.HOME);
    }

    private void showError(String title, String message) {
        if (destroyed) return;
        failed = true;
        mainHandler.removeCallbacks(loadTimeout);
        loading.setVisibility(View.GONE);
        errorTitle.setText(title);
        errorMessage.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
        errorPanel.bringToFront();
        if (webView != null) webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }

    private void handleBack() {
        if (backPending || destroyed) return;
        if (webView != null && !failed && UrlPolicy.isFirstParty(webView.getUrl())) {
            backPending = true;
            // A fixed, trusted-page command closes a web dialog before leaving
            // its page. No JavaScript interface or app/file APIs are exposed.
            webView.evaluateJavascript("(() => { const dialog = document.querySelector('dialog[open]'); if (dialog) { dialog.close(); return true; } return false; })()", value -> {
                backPending = false;
                if (!destroyed && !"true".equals(value)) navigateBackOrFinish();
            });
        } else navigateBackOrFinish();
    }

    private void navigateBackOrFinish() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else finish();
    }

    @SuppressWarnings("deprecation") @Override public void onBackPressed() { handleBack(); }

    @Override protected void onSaveInstanceState(Bundle outState) {
        if (webView != null && UrlPolicy.isFirstParty(webView.getUrl())) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        mainHandler.removeCallbacks(pushSync);
        if (webView != null) webView.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        mainHandler.removeCallbacks(pushSync);
        mainHandler.post(pushSync);
    }

    @Override public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        browserFrame.setBackgroundColor(backgroundColor());
        errorPanel.setBackgroundColor(backgroundColor());
        errorTitle.setTextColor(textColor());
        errorMessage.setTextColor(textColor());
    }

    @Override protected void onDestroy() {
        destroyed = true;
        mainHandler.removeCallbacksAndMessages(null);
        cancelFileSelection();
        for (WebView popup : new ArrayList<>(pendingPopups)) disposePopup(popup);
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        if (downloads != null) downloads.close();
        if (webView != null) {
            browserFrame.removeView(webView);
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private boolean night() { return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES; }
    private int backgroundColor() { return night() ? Color.rgb(21, 24, 39) : Color.rgb(246, 247, 251); }
    private int textColor() { return night() ? Color.rgb(239, 241, 250) : Color.rgb(35, 38, 62); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
