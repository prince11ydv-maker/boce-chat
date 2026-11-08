# Classnest for Android

This Android 8.0+ client opens the trusted Classnest website at `https://pusoe.vercel.app`. It uses the existing account, semester permissions, backend, and private server storage. There is no separate mobile database or copied account list. Normal website updates appear in the app after loading the latest page.

The native app provides a document picker for note/notice uploads, authenticated attachment downloads, Back navigation, a connection/retry screen, phone alerts, and an app menu with browser fallback and sharing. The `ClassnestAndroid/1.1.0` user-agent marker suppresses the website's home-screen-install promotion inside the APK. Version 1.1.0 uses version code 2 and the same release certificate as 1.0.0.

The app needs internet. Native phone alerts use Firebase Cloud Messaging (FCM), Google Play services, valid backend credentials, and explicit notification permission. Sign in to an approved account, then choose **Enable phone alerts** in the app menu; turn them off there too. Android 13+ requests runtime permission. Battery restrictions, Focus modes, force-stop, and provider delays can prevent or delay alerts. Real delivery on a physical phone has not been verified here. The free iPhone home-screen app is documented in [MOBILE.md](../../MOBILE.md); an APK cannot be installed on an iPhone.

## Build

Use JDK 17+, Android SDK Platform 35, and Build Tools 35.0.0. The project pins Android Gradle Plugin 8.9.2, Gradle 8.11.1, and Firebase Messaging 26.0.1. Firebase includes AndroidX/transitive runtime dependencies; Analytics is not added. Building does not require Compose or an NDK installation. The official wrapper JAR SHA-256 is `2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046`. Its properties verify the Gradle ZIP against `f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6`.

### Public Firebase configuration

The checked-in `firebase-client.json` is the public Android client configuration downloaded from Firebase for package `app.classnest.pusoe`, project `classnest-pu-soe`. It contains the public project/sender ID, mobile app ID, and client API key. These identify the app; they cannot authorize server push delivery. Gradle extracts only those client fields into Android resources consumed by the official Firebase initializer. The Google services Gradle plugin is not required.

Set `CLASSNEST_FIREBASE_CONFIG` to an absolute path to a different public Android client JSON to override the checked-in file. A malformed file or server-service-account JSON fails configuration. With no client file, the app builds with `FIREBASE_CONFIGURED=false` and disables native alerts. The released 1.1.0 APK has this flag set to `true`. Debug builds use the `.debug` package suffix; Firebase API-key restrictions or a separate Firebase debug app may need adjustment for debug-device registration.

**Never put a service-account private key, SMTP credential, VAPID private key, or release signing key in this file, the APK, or GitHub.** The backend's Firebase server credential stays in private hosting configuration.

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

Run `gradlew.bat :app:assembleRelease :app:lintRelease` in that private signing environment, then run `check-policy.ps1`. Keep the same signing key for future updates. Keystores, passwords, `local.properties`, caches, and generated build files stay out of GitHub/source ZIPs. Only the deliberately published signed artifacts under `mobile/releases` belong in the source archive.

## Security and device checks

The WebView accepts only the canonical HTTPS Classnest origin. External HTTPS links and plain support email open through Android's chosen app; file/content/intent/javascript navigation and TLS downgrades are blocked. There is no JavaScript interface or certificate-error bypass. Camera, microphone, and broad storage permissions are not requested. Notification permission requires user approval. Firebase adds network-state, wake-lock, and protected cloud-messaging receiver permissions. File selection accepts only `content://` document-picker results; the backend still validates files and posting permissions.

FCM auto-init is off until opt-in. Registration reads the current HttpOnly WebView session on the UI thread and posts its token to the canonical `/api/push/devices`, with the same-origin CSRF headers and no redirects. Only the backend device ID is stored in private preferences; the session cookie is never persisted by this code or logged. The backend binds devices to the current login session and rechecks membership/source visibility before delivery. Logout removes the session-bound registration. Foreground synchronization reconnects a changed login; token refresh updates the binding.

FCM uses high-priority data messages, not automatic notification payloads. The native service checks local opt-in, permission, and session presence before posting fixed generic text. This also prevents a queued alert displaying after an offline opt-out. A tap accepts only the canonical `/?semester=1..30#notifications` route; account permissions are still checked when the page loads. Arbitrary API URLs, other origins, unsafe schemes, extra parameters, and invalid semester numbers are rejected. Alert data never contains note text, teacher absence reasons, or private class content.

Only the canonical notes/notices attachment endpoints can start native downloads. The metadata request sends the current account cookie only to that exact first-party HTTPS endpoint, so authenticated student semester restrictions still apply; a 403 stops the download. Redirects are followed manually and limited to the exact project's signed attachment storage path. No cookie or Authorization header is forwarded to storage or DownloadManager. Metadata uses HEAD, with a GET fallback closed without buffering the file. DownloadManager receives the validated signed URL; it expires after 60 seconds, so a transfer that starts much later may fail. Return to Classnest and tap Download again for a fresh authorized link. Android 10+ saves to public Downloads. Android 8/9 uses app-specific external Downloads without a storage permission; its completed notification opens the file. Uninstalling the app removes that older-device app-specific folder, so copy important files first. Browser-generated blob downloads such as calendar export and unsupported private backup downloads use the app menu's **Open in browser** fallback.

The host-side URL policy harness passes 72 checks covering origin confusion, unsafe schemes, userinfo/port tricks, signed storage, redirects, filenames, and notification links. It is not a substitute for testing on a phone. Verify the following on an Android device before wide distribution:

1. Student, teacher, and admin login/logout; same-semester student restrictions.
2. Existing account/session behavior after app restart, and current teacher assignments.
3. Photo/PDF selection, approved upload, and attachment preview/download.
4. Light/dark device theme, keyboard/dialog scrolling, and system-bar insets.
5. Android Back through pages and dialogs, interrupted connectivity, and retry.
6. Enable alerts, deny/allow permission, receive an alert with the app closed, and tap it.
7. Disable alerts while offline, logout/account switching, and semester reassignment.

Developer-store enrollment, Play publication, automatic APK updates, iOS signing, and App Store review are separate from building this direct-install Android APK.
