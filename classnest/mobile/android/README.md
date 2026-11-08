# Classnest for Android

This Android 8.0+ client opens the trusted Classnest website at `https://pusoe.vercel.app`. It uses the existing account, semester permissions, backend, and private server storage. There is no separate mobile database or copied account list. Normal website updates appear in the app after loading the latest page.

The native app provides an Android document picker for note/notice uploads, system download notifications for public note/notice attachments, Back navigation, a connection/retry screen, and a small app menu with browser fallback and sharing. The `ClassnestAndroid/1.0.0` user-agent marker suppresses the website's home-screen-install promotion inside the APK.

The app needs an internet connection. Class alerts are the website's in-app inbox and opted-in email; this APK does not add operating-system push or promise background reminders. Android may suspend the app while it is closed. The free iPhone home-screen app is documented in the website's mobile installation guide; an APK cannot be installed on an iPhone.

## Build

Use JDK 17+, Android SDK Platform 35, and the matching build tools. The project uses Android Gradle Plugin 8.9.2 and Gradle 8.11.1, with no AndroidX, Compose, NDK, or third-party runtime dependency. The official Gradle 8.11.1 wrapper JAR is included and was verified against SHA-256 `2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046`. Its properties pin and verify the Gradle distribution ZIP with SHA-256 `f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6`.

Set `ANDROID_HOME` to the Android SDK. An ignored `local.properties` with an `sdk.dir` entry is another local-only option. Then, from this directory:

```powershell
.\gradlew.bat :app:assembleDebug
.\check-policy.ps1
```

Debug builds use `app.classnest.pusoe.debug`, have WebView debugging enabled, and are for testing. Release builds use `app.classnest.pusoe`, disable WebView debugging, and are unsigned unless the owner privately supplies these environment variables:

- `CLASSNEST_KEYSTORE`: absolute path to the owner's signing keystore.
- `CLASSNEST_KEYSTORE_PASSWORD`: keystore password.
- `CLASSNEST_KEY_ALIAS`: signing alias.
- `CLASSNEST_KEY_PASSWORD`: signing key password.

Run `gradlew.bat :app:assembleRelease` in that private signing environment. Keep the same signing key for future APK updates. Keystores, passwords, `local.properties`, Gradle caches, and generated APK/AAB files are ignored and must stay out of GitHub/source ZIPs.

## Security and device checks

The WebView accepts only the canonical HTTPS Classnest origin. External HTTPS links and a plain support email open through Android's chosen app, while file/content/intent/javascript navigation and TLS downgrades are blocked. It does not expose a JavaScript interface, accept certificate-error bypasses, or grant broad storage, camera, microphone, or notification access. File selection accepts only `content://` results from the Android document picker, and the backend continues to validate files and posting permissions.

Only the canonical notes/notices attachment endpoints can start native downloads. The metadata request sends the current account cookie only to that exact first-party HTTPS endpoint, so authenticated student semester restrictions still apply; a 403 stops the download. Redirects are followed manually and limited to the exact project's signed attachment storage path. No cookie or Authorization header is forwarded to storage or DownloadManager. Metadata uses HEAD, with a GET fallback closed without buffering the file. DownloadManager receives the validated signed URL; it expires after 60 seconds, so a transfer that starts much later may fail. Return to Classnest and tap Download again for a fresh authorized link. Android 10+ saves to public Downloads. Android 8/9 uses app-specific external Downloads without a storage permission; its completed notification opens the file. Uninstalling the app removes that older-device app-specific folder, so copy important files first. Browser-generated blob downloads such as calendar export and unsupported private backup downloads use the app menu's **Open in browser** fallback.

The host-side URL policy test covers origin confusion, unsafe schemes, userinfo/port tricks, signed storage scope, redirects, and filename safety. It is not a substitute for testing on a phone. Verify the following on an Android device before wide distribution:

1. Student, teacher, and admin login/logout; same-semester student restrictions.
2. Existing account/session behavior after app restart, and current teacher assignments.
3. Photo/PDF selection, approved upload, and attachment preview/download.
4. Light/dark device theme, keyboard/dialog scrolling, and system-bar insets.
5. Android Back through pages and dialogs, interrupted connectivity, and retry.

Developer-store enrollment, Play publication, automatic APK updates, iOS signing, and App Store review are separate from building this direct-install Android APK.
