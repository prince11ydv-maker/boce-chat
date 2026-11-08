package app.classnest.pusoe;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.regex.Pattern;

/** Pure Java policy shared by the WebView, downloader, and host-side tests. */
public final class UrlPolicy {
    public static final String ORIGIN = "https://pusoe.vercel.app";
    public static final String HOME = ORIGIN + "/?source=android#home";
    private static final String HOST = "pusoe.vercel.app";
    private static final String STORAGE_HOST = "bsuspunntvruyrtfaycu.supabase.co";
    private static final String UUID = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
    private static final Pattern DOWNLOAD = Pattern.compile("/api/(?:notes|notices)/" + UUID + "/download");
    private static final Pattern STORAGE = Pattern.compile("/storage/v1/object/sign/classnest-attachments/notes/" + UUID + "\\.(?:pdf|txt|md|docx|pptx|xlsx|png|jpg|jpeg|webp|gif|bmp|avif|heic|heif|tif|tiff)");
    private static final Pattern MAILBOX = Pattern.compile("[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\\.[A-Za-z]{2,63}");

    private UrlPolicy() { }

    private static URI parse(String value) {
        if (value == null || value.length() > 8192 || value.isEmpty()) return null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c <= 0x20 || c == 0x7f || c == '\\') return null;
        }
        try { return new URI(value); } catch (URISyntaxException ignored) { return null; }
    }

    private static boolean https(URI uri) {
        return uri != null && !uri.isOpaque() && "https".equalsIgnoreCase(uri.getScheme())
            && uri.getRawUserInfo() == null && uri.getHost() != null
            && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    public static boolean isFirstParty(String value) {
        URI uri = parse(value);
        return https(uri) && HOST.equals(uri.getHost().toLowerCase(Locale.ROOT));
    }

    public static boolean isAttachmentDownload(String value) {
        URI uri = parse(value);
        return isFirstParty(value) && uri.getRawQuery() == null && uri.getRawFragment() == null
            && DOWNLOAD.matcher(uri.getRawPath()).matches();
    }

    /** Notification taps only open the account inbox, never arbitrary web/API URLs. */
    public static String notificationDestination(String value) {
        if (value == null) return null;
        String absolute = value.startsWith("/?") ? ORIGIN + value : value;
        URI uri = parse(absolute);
        if (!isFirstParty(absolute) || !"/".equals(uri.getRawPath()) || !"notifications".equals(uri.getRawFragment())) return null;
        String query = uri.getRawQuery();
        if (query == null || !query.matches("semester=(?:[1-9]|[12][0-9]|30)")) return null;
        return ORIGIN + "/?" + query + "#notifications";
    }

    public static boolean isSignedStorageDownload(String value) {
        URI uri = parse(value);
        if (!https(uri) || !STORAGE_HOST.equals(uri.getHost().toLowerCase(Locale.ROOT))
            || uri.getRawFragment() != null || !STORAGE.matcher(uri.getRawPath()).matches()) return false;
        String query = uri.getRawQuery();
        if (query == null || query.length() > 6000) return false;
        boolean token = false, download = false;
        for (String field : query.split("&", -1)) {
            if (field.startsWith("token=") && !token && field.substring(6).matches("[A-Za-z0-9._~-]{1,5000}")) token = true;
            else if (field.startsWith("download=") && !download && field.length() <= 900) download = true;
            else return false;
        }
        return token;
    }

    public static boolean isDownloadSource(String value) {
        return isAttachmentDownload(value) || isSignedStorageDownload(value);
    }

    public static boolean isExternalHttps(String value) {
        URI uri = parse(value);
        return https(uri) && !isFirstParty(value);
    }

    public static boolean isMailTo(String value) {
        URI uri = parse(value);
        return uri != null && "mailto".equalsIgnoreCase(uri.getScheme()) && uri.isOpaque()
            && uri.getRawFragment() == null && MAILBOX.matcher(uri.getRawSchemeSpecificPart()).matches();
    }

    public static String resolveStorageRedirect(String from, String location) {
        if (!isDownloadSource(from) || location == null || location.length() > 8192) return null;
        URI origin = parse(from), next = parse(location);
        if (next == null) return null;
        String resolved = origin.resolve(next).toString();
        return isSignedStorageDownload(resolved) ? resolved : null;
    }

    public static String safeFilename(String value) {
        String cleaned = value == null ? "" : value.replaceAll("[\\x00-\\x1f\\x7f\\\\/:*?\"<>|\\u202a-\\u202e\\u2066-\\u2069]", "_").trim();
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) return "classnest-attachment";
        if (cleaned.length() > 160) {
            int dot = cleaned.lastIndexOf('.');
            String suffix = dot > 0 && cleaned.length() - dot <= 10 ? cleaned.substring(dot) : "";
            cleaned = cleaned.substring(0, 160 - suffix.length()) + suffix;
        }
        return cleaned;
    }
}
