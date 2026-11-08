package app.classnest.pusoe;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.widget.Toast;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Authorize first-party metadata, then download without forwarding cookies. */
final class AttachmentDownloads {
    private static final long MAX_BYTES = 20L * 1024 * 1024;
    private final Activity activity;
    private final String userAgent;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean resolving = new AtomicBoolean(false);
    private volatile boolean closed;

    AttachmentDownloads(Activity activity, String userAgent) {
        this.activity = activity;
        this.userAgent = userAgent;
    }

    void start(String source) {
        if (closed) return;
        if (!UrlPolicy.isAttachmentDownload(source)) {
            message("Use Open in browser from the app menu for this download.");
            return;
        }
        if (!resolving.compareAndSet(false, true)) {
            message("Preparing your download. Please wait a moment.");
            return;
        }
        // Only this exact first-party route receives the current session. A
        // logged-in student must retain their semester authorization check.
        String accountCookie = CookieManager.getInstance().getCookie(UrlPolicy.ORIGIN);
        message("Preparing attachment…");
        executor.execute(() -> {
            try {
                Metadata metadata = resolve(source, accountCookie);
                activity.runOnUiThread(() -> {
                    resolving.set(false);
                    if (!closed && !activity.isFinishing()) enqueue(metadata);
                });
            } catch (IOException | RuntimeException error) {
                String notice = error instanceof DownloadFailure ? error.getMessage()
                    : "The download could not start. Check your connection and try again.";
                activity.runOnUiThread(() -> {
                    resolving.set(false);
                    if (!closed && !activity.isFinishing()) message(notice);
                });
            }
        });
    }

    private Metadata resolve(String source, String accountCookie) throws IOException {
        String current = source;
        boolean useHead = true;
        for (int redirects = 0; redirects <= 4; ) {
            if (!UrlPolicy.isDownloadSource(current)) throw new IOException("Blocked attachment URL");
            HttpURLConnection connection = (HttpURLConnection) new URL(current).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setUseCaches(false);
            connection.setRequestMethod(useHead ? "HEAD" : "GET");
            connection.setRequestProperty("User-Agent", userAgent);
            if (UrlPolicy.isAttachmentDownload(current) && accountCookie != null && !accountCookie.isEmpty()) {
                connection.setRequestProperty("Cookie", accountCookie);
            }
            // Redirects are manual. The cookie is never added to a storage
            // request, and no Authorization header is copied between origins.
            try {
                int status = connection.getResponseCode();
                if ((status == 405 || status == 501) && useHead) {
                    useHead = false;
                    continue;
                }
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String next = UrlPolicy.resolveStorageRedirect(current, connection.getHeaderField("Location"));
                    if (next == null || redirects++ == 4) throw new IOException("Blocked attachment redirect");
                    current = next;
                    continue;
                }
                if (status == 401 || status == 403) throw new DownloadFailure("This attachment is not available to your account. Choose notes from your assigned semester.");
                if (status == 404) throw new DownloadFailure("This attachment is no longer available.");
                if (status != 200) throw new IOException("Attachment unavailable");
                if (!UrlPolicy.isSignedStorageDownload(current)) throw new DownloadFailure("Use Open in browser from the app menu for this download.");
                long size = connection.getContentLengthLong();
                if (size == 0 || size > MAX_BYTES) throw new IOException("Invalid attachment size");
                String disposition = connection.getHeaderField("Content-Disposition");
                if (disposition != null && disposition.length() > 2048) disposition = null;
                String filename = UrlPolicy.safeFilename(URLUtil.guessFileName(current, disposition, connection.getContentType()));
                int dot = filename.lastIndexOf('.');
                String extension = dot >= 0 ? filename.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
                String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                return new Metadata(current, filename, mime == null ? "application/octet-stream" : mime);
            } finally {
                // HEAD normally supplies the metadata. A GET fallback is closed
                // without reading the body, never buffered into app memory.
                connection.disconnect();
            }
        }
        throw new IOException("Too many attachment redirects");
    }

    private void enqueue(Metadata metadata) {
        try {
            // Only the already-authorized, validated storage URL is queued.
            // Sending a Cookie header through DownloadManager's automatic
            // redirects could expose a first-party session to another origin.
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(metadata.url));
            request.setTitle(metadata.filename);
            request.setDescription("Classnest attachment");
            request.setMimeType(metadata.mime);
            request.addRequestHeader("User-Agent", userAgent);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String destination = "Classnest-" + System.currentTimeMillis() + "-" + metadata.filename;
            if (Build.VERSION.SDK_INT >= 29) {
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, destination);
            } else {
                // Android 8/9 public Downloads would need broad storage access.
                // App-specific Downloads keeps the picker permission-free.
                request.setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, destination);
            }
            DownloadManager manager = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("No download service");
            manager.enqueue(request);
            message("Download started. Open it from your phone’s Downloads notification.");
        } catch (RuntimeException ignored) {
            message("Downloads are unavailable. Use Open in browser from the app menu.");
        }
    }

    private void message(String text) {
        if (!closed) Toast.makeText(activity, text, Toast.LENGTH_LONG).show();
    }

    void close() {
        closed = true;
        executor.shutdownNow();
    }

    private static final class Metadata {
        final String url, filename, mime;
        Metadata(String url, String filename, String mime) {
            this.url = url;
            this.filename = filename;
            this.mime = mime;
        }
    }

    private static final class DownloadFailure extends IOException {
        DownloadFailure(String message) { super(message); }
    }
}
