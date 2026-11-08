package app.classnest.pusoe;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.widget.Toast;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Opt-in phone alerts use the WebView's current secure session, without a JS bridge. */
final class NativePush {
    static final String CHANNEL = "classnest_updates";
    private static final String PREFERENCES = "classnest_phone_alerts";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService NETWORK = Executors.newSingleThreadExecutor();
    private static String boundCookieHash = "", pendingCookieHash = "";
    private static long lastAttempt;

    private NativePush() { }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    static boolean enabled(Context context) {
        return preferences(context).getBoolean("enabled", false);
    }

    static boolean configured(Context context) {
        if (!BuildConfig.FIREBASE_CONFIGURED) return false;
        try {
            if (FirebaseApp.getApps(context).isEmpty()) return FirebaseApp.initializeApp(context) != null;
            return true;
        } catch (IllegalStateException ignored) { return false; }
    }

    static void createChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, context.getString(R.string.phone_alert_channel), NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(context.getString(R.string.phone_alert_channel_description));
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
    }

    static boolean permissionGranted(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        return manager.areNotificationsEnabled() && (channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE);
    }

    static void enable(Context context) {
        Context app = context.getApplicationContext();
        if (!configured(app)) { inform(app, R.string.phone_alert_unavailable); return; }
        if (sessionCookie().isEmpty()) { inform(app, R.string.phone_alert_sign_in); return; }
        if (!permissionGranted(app)) { inform(app, R.string.phone_alert_permission); return; }
        preferences(app).edit().putBoolean("enabled", true).apply();
        FirebaseMessaging.getInstance().setAutoInitEnabled(true);
        synchronize(app, true);
    }

    /** Called on resume and after trusted page loads; a changed login rebinds the token. */
    static void synchronize(Context context, boolean feedback) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            MAIN.post(() -> synchronize(context, feedback));
            return;
        }
        Context app = context.getApplicationContext();
        if (!enabled(app) || !configured(app) || !permissionGranted(app)) return;
        String cookie = sessionCookie(), cookieHash = digest(cookie);
        if (cookie.isEmpty()) {
            boundCookieHash = "";
            preferences(app).edit().remove("device_id").apply();
            app.getSystemService(NotificationManager.class).cancelAll();
            if (feedback) inform(app, R.string.phone_alert_sign_in);
            return;
        }
        long now = android.os.SystemClock.elapsedRealtime();
        if (!feedback && (cookieHash.equals(boundCookieHash) || cookieHash.equals(pendingCookieHash) || now - lastAttempt < 10000)) return;
        pendingCookieHash = cookieHash;
        lastAttempt = now;
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                pendingCookieHash = "";
                if (feedback) { failedEnable(app); inform(app, R.string.phone_alert_retry); }
                return;
            }
            register(app, task.getResult(), cookie, feedback);
        });
    }

    static void refreshed(Context context, String token) {
        MAIN.post(() -> {
            if (!enabled(context) || !permissionGranted(context)) return;
            String cookie = sessionCookie();
            if (!cookie.isEmpty()) register(context.getApplicationContext(), token, cookie, false);
        });
    }

    private static void register(Context app, String token, String cookie, boolean feedback) {
        if (!enabled(app) || token.isEmpty() || token.length() > 4096) return;
        NETWORK.execute(() -> {
            int status = 0;
            String deviceId = "";
            try {
                JSONObject data = new JSONObject().put("kind", "android").put("token", token).put("label", "Android app");
                Response response = request("POST", "/api/push/devices", data.toString(), cookie);
                status = response.status;
                if (status == 200 || status == 201) deviceId = new JSONObject(response.body).optString("id", "");
            } catch (Exception ignored) { /* Tokens, cookies, and backend errors never enter logs. */ }
            final int result = status;
            final String id = deviceId;
            MAIN.post(() -> {
                pendingCookieHash = "";
                if (!enabled(app) || !cookie.equals(sessionCookie())) {
                    if (id.matches("[A-Za-z0-9_-]{1,128}")) NETWORK.execute(() -> remove(id, cookie));
                    return;
                }
                if ((result == 200 || result == 201) && id.matches("[A-Za-z0-9_-]{1,128}")) {
                    boundCookieHash = digest(cookie);
                    preferences(app).edit().putString("device_id", id).apply();
                    if (feedback) inform(app, R.string.phone_alert_enabled);
                } else if (feedback) {
                    failedEnable(app);
                    inform(app, result == 401 || result == 403 ? R.string.phone_alert_sign_in : R.string.phone_alert_retry);
                }
            });
        });
    }

    static void disable(Context context) {
        Context app = context.getApplicationContext();
        String cookie = sessionCookie(), id = preferences(app).getString("device_id", "");
        preferences(app).edit().putBoolean("enabled", false).remove("device_id").apply();
        boundCookieHash = "";
        pendingCookieHash = "";
        app.getSystemService(NotificationManager.class).cancelAll();
        if (configured(app)) {
            FirebaseMessaging.getInstance().setAutoInitEnabled(false);
            FirebaseMessaging.getInstance().deleteToken();
        }
        if (!cookie.isEmpty() && id.matches("[A-Za-z0-9_-]{1,128}")) NETWORK.execute(() -> remove(id, cookie));
        inform(app, R.string.phone_alert_disabled);
    }

    private static void failedEnable(Context context) {
        preferences(context).edit().putBoolean("enabled", false).remove("device_id").apply();
        boundCookieHash = "";
        FirebaseMessaging.getInstance().setAutoInitEnabled(false);
        FirebaseMessaging.getInstance().deleteToken();
    }

    private static void remove(String id, String cookie) {
        try { request("DELETE", "/api/push/devices/" + id, null, cookie); } catch (Exception ignored) { }
    }

    private static Response request(String method, String path, String body, String cookie) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(UrlPolicy.ORIGIN + path).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(12000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Origin", UrlPolicy.ORIGIN);
        connection.setRequestProperty("X-Classnest-Request", "1");
        connection.setRequestProperty("Cookie", cookie);
        connection.setRequestProperty("User-Agent", "ClassnestAndroid/" + BuildConfig.VERSION_NAME);
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (body != null) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream source = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (source != null) try (InputStream input = source) {
                byte[] buffer = new byte[2048];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 16384) throw new java.io.IOException("Response too large");
                    output.write(buffer, 0, count);
                }
            }
            return new Response(status, new String(output.toByteArray(), StandardCharsets.UTF_8));
        } finally { connection.disconnect(); }
    }

    static String sessionCookie() {
        String cookies = CookieManager.getInstance().getCookie(UrlPolicy.ORIGIN);
        if (cookies != null) for (String part : cookies.split(";")) {
            String value = part.trim();
            if (value.matches("classnest_session=[A-Za-z0-9._~-]{16,256}")) return value;
        }
        return "";
    }

    private static String digest(String value) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (byte b : hash) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException ignored) { throw new IllegalStateException("SHA-256 unavailable"); }
    }

    private static void inform(Context context, int message) {
        MAIN.post(() -> Toast.makeText(context, message, Toast.LENGTH_LONG).show());
    }

    private static final class Response {
        final int status;
        final String body;
        Response(int status, String body) { this.status = status; this.body = body; }
    }
}
