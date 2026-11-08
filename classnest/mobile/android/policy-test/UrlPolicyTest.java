package app.classnest.pusoe;

public final class UrlPolicyTest {
    private static int checks;
    private static final String ID = "a51035a9-b6db-46c0-bb1d-88e02ee49bca";
    private static final String START = UrlPolicy.ORIGIN + "/api/notes/" + ID + "/download";
    private static final String SIGNED = "https://bsuspunntvruyrtfaycu.supabase.co/storage/v1/object/sign/classnest-attachments/notes/" + ID + ".pdf?token=eyJhbGci.demo.signature&download=Class%20notes.pdf";

    public static void main(String[] args) {
        yes(UrlPolicy.isFirstParty(UrlPolicy.HOME), "canonical app URL");
        yes(UrlPolicy.isFirstParty("https://PUSOE.vercel.app:443/#notices"), "canonical host case/default HTTPS port");
        yes(UrlPolicy.isFirstParty("https://pusoe.vercel.app/#verify-email/private-token"), "same-origin email flow");
        for (String url : new String[] {
            "http://pusoe.vercel.app/", "https://pusoe.vercel.app:444/", "https://pusoe.vercel.app.evil.test/",
            "https://pusoe.vercel.app@evil.test/", "https://evil.test@pusoe.vercel.app/", "https://pusoe.vercel.app./",
            "file:///data/data/app.classnest.pusoe/app_webview/Cookies", "content://private/provider",
            "javascript:alert(1)", "intent://pusoe.vercel.app/#Intent;end", "https://pusoe.vercel.app\\@evil.test/",
            " https://pusoe.vercel.app/", "https://pusoe.vercel.app/\r\n", "https://pusoe.vercel.app%2eevil.test/",
            "//pusoe.vercel.app/", "https://", "", null
        }) no(UrlPolicy.isFirstParty(url), "reject untrusted first-party URL");

        yes(UrlPolicy.isAttachmentDownload(START), "known public note download");
        yes(UrlPolicy.isAttachmentDownload(START.replace("/notes/", "/notices/")), "known public notice download");
        no(UrlPolicy.isAttachmentDownload(START + "?url=https://evil.test/"), "no arbitrary download query");
        no(UrlPolicy.isAttachmentDownload(START + "#token"), "no download fragment");
        no(UrlPolicy.isAttachmentDownload(START.replace(ID, "..")), "no path traversal");
        no(UrlPolicy.isAttachmentDownload(START.replace("/download", "/preview")), "preview is not a native download");
        no(UrlPolicy.isAttachmentDownload(START.replace("pusoe.vercel.app", "evil.test")), "download origin binding");

        yes(UrlPolicy.isSignedStorageDownload(SIGNED), "expected project's bounded signed attachment");
        yes(UrlPolicy.isSignedStorageDownload(SIGNED.replace(".pdf?", ".heic?")), "supported original image download");
        no(UrlPolicy.isSignedStorageDownload(SIGNED.replace("bsuspunntvruyrtfaycu", "different-project")), "storage project binding");
        no(UrlPolicy.isSignedStorageDownload(SIGNED.replace("/notes/", "/staged/")), "no staged object access");
        no(UrlPolicy.isSignedStorageDownload(SIGNED.replace(".pdf?", ".html?")), "no active markup attachment");
        no(UrlPolicy.isSignedStorageDownload(SIGNED + "&token=another"), "duplicate signed token rejected");
        no(UrlPolicy.isSignedStorageDownload(SIGNED + "&redirect=https://evil.test/"), "unknown signed parameter rejected");
        no(UrlPolicy.isSignedStorageDownload(SIGNED.replace("?token=eyJhbGci.demo.signature&", "?")), "signed token required");
        no(UrlPolicy.isSignedStorageDownload(SIGNED.replace("https://", "http://")), "no storage TLS downgrade");
        no(UrlPolicy.isSignedStorageDownload(SIGNED + "#fragment"), "storage fragment rejected");

        equal(SIGNED, UrlPolicy.resolveStorageRedirect(START, SIGNED), "public API to exact signed storage");
        equal(null, UrlPolicy.resolveStorageRedirect(START, "https://evil.test/file.pdf"), "external redirect blocked");
        equal(null, UrlPolicy.resolveStorageRedirect(START, "/api/account"), "private API redirect blocked");
        equal(null, UrlPolicy.resolveStorageRedirect(START, "http://bsuspunntvruyrtfaycu.supabase.co/file"), "redirect downgrade blocked");
        equal(null, UrlPolicy.resolveStorageRedirect("https://evil.test/", SIGNED), "untrusted start blocked");
        yes(UrlPolicy.isExternalHttps("https://example.edu/notes"), "user-tapped HTTPS external browser link");
        no(UrlPolicy.isExternalHttps("https://user:pass@example.edu/"), "credentials in external URL rejected");
        no(UrlPolicy.isExternalHttps("https://example.edu:444/"), "nonstandard external port rejected");
        no(UrlPolicy.isExternalHttps("intent://example.edu/"), "no Android intent link execution");
        yes(UrlPolicy.isMailTo("mailto:prince11ydv@gmail.com"), "plain support email");
        no(UrlPolicy.isMailTo("mailto:person@example.com?bcc=secret@example.com"), "mail header injection rejected");
        no(UrlPolicy.isMailTo("mailto:person@example.com%0aBCC:secret@example.com"), "encoded mail control rejected");

        equal("class_notes.pdf", UrlPolicy.safeFilename("class/notes.pdf"), "filename path separator stripped");
        equal(".._.._notes.pdf", UrlPolicy.safeFilename("../../notes.pdf"), "filename traversal becomes plain name");
        equal("classnest-attachment", UrlPolicy.safeFilename(".."), "reserved filename rejected");
        equal("classnest-attachment", UrlPolicy.safeFilename(null), "missing filename fallback");
        yes(UrlPolicy.safeFilename("x".repeat(300) + ".pdf").length() == 160, "filename length bounded");
        yes(UrlPolicy.safeFilename("x".repeat(300) + ".pdf").endsWith(".pdf"), "bounded name retains extension");
        no(UrlPolicy.safeFilename("notes\u202efile.pdf").contains("\u202e"), "bidirectional filename control removed");
        equal(UrlPolicy.ORIGIN + "/?semester=3#notifications", UrlPolicy.notificationDestination("/?semester=3#notifications"), "relative push inbox link");
        equal(UrlPolicy.ORIGIN + "/?semester=30#notifications", UrlPolicy.notificationDestination(UrlPolicy.ORIGIN + "/?semester=30#notifications"), "canonical push inbox link");
        for (String value : new String[]{null, "javascript:alert(1)", "//evil.test/?semester=3#notifications", "https://evil.test/?semester=3#notifications", "http://pusoe.vercel.app/?semester=3#notifications", "https://person@pusoe.vercel.app/?semester=3#notifications", "/?semester=0#notifications", "/?semester=31#notifications", "/?semester=3&redirect=https://evil.test/#notifications", "/?semester=3#admin", "/api/users?semester=3#notifications", "/?semester=%33#notifications", "/?semester=3#notifications\n"}) {
            equal(null, UrlPolicy.notificationDestination(value), "unsafe push destination rejected");
        }
        System.out.println("Classnest Android URL policy: " + checks + " checks passed.");
    }

    private static void yes(boolean value, String reason) {
        checks++;
        if (!value) throw new AssertionError(reason);
    }
    private static void no(boolean value, String reason) { yes(!value, reason); }
    private static void equal(Object expected, Object actual, String reason) {
        checks++;
        if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError(reason);
    }
}
