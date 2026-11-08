# Classnest on Android and iPhone

Website: **https://pusoe.vercel.app**. The signed Android APK is built and verified, and the home-screen app and student semester-lock website update are READY in production. Deployment and verification evidence is recorded in [DEPLOYMENT.md](DEPLOYMENT.md).

## Install the free home-screen app

The website provides **Install Classnest** in its navigation and footer. It uses the same website, accounts, database, notes, notices, and timetable.

- **Android:** open Classnest in Chrome, choose **Install Classnest**, then confirm the browser's installation prompt. If no prompt is available, use the browser menu's **Install app** or **Add to Home screen** option.
- **iPhone or iPad:** open Classnest in Safari, tap **Share → Add to Home Screen**, keep **Open as Web App** enabled if shown, then tap **Add**.

Open the new Classnest icon and sign in with the existing account. Installed apps and ordinary browser tabs can keep separate browser storage or sessions, so the installed app may ask for sign-in again. These installations do not require an App Store or Google Play developer account.

## Android APK

The separate Android client is built from [mobile/android](mobile/android/README.md). It supports Android 8.0 and newer (API 26+), with application ID `app.classnest.pusoe`, version `1.0.0`, and version code `1`.

Download [Classnest-1.0.0.apk](mobile/releases/Classnest-1.0.0.apk), or use the [public GitHub download](https://github.com/prince11ydv-maker/boce-chat/raw/refs/heads/main/classnest/mobile/releases/Classnest-1.0.0.apk). The APK was published in commit `a8d62fc`. The file is **28,064 bytes**, with SHA-256 `8f288012aa5539b4eef45e0ee1d37e0b88f379f3ca0fd9c6dc6299a31b44596e`. Android handles installation of a downloaded APK and may ask the owner to allow installation from the chosen browser or file manager.

The client opens the trusted HTTPS Classnest website inside an Android WebView. The existing backend continues to enforce sign-in, permissions, and semester membership. It includes native file selection, document downloads, Back navigation, loading/error screens, and an app menu for reload, sharing the public website, or opening it in a browser. Website changes appear without rebuilding the APK; changes to native code require a new signed APK with a higher version code.

The APK is for Android. iPhone users use the home-screen app above. No Apple App Store or Google Play publication is included in this release.

### Files and downloads

File uploads use Android's document picker without requesting broad device-storage access. Notes and notices keep their existing file validation and size limits.

For a native attachment download, the app authorizes the exact first-party download URL using its current session, handles redirects manually, and validates the project's HTTPS signed storage URL. Session cookies are never forwarded to Supabase or Android's DownloadManager. Signed URLs expire quickly; if a queued download waits too long and fails, open Classnest and choose **Download** again to authorize a fresh URL.

Android 10 and newer saves downloaded files to public Downloads. Android 8 and 9 uses app-specific Downloads to avoid broad storage permission. Some browser-only exports, including the administrator database backup and generated calendar files, should be opened through the app menu's **Open in browser** option; the browser may require its own sign-in.

## Student semester membership

Signed-in student accounts are restricted to the semester assigned by the administrator. Their semester selector is disabled and contains only that semester. Changing a URL, query, or ordinary API request does not switch the account's semester. Cross-semester state, timetables, note/notice files, and note posting/editing/deletion are checked on the server using the current stored account and membership.

Approved teachers and administrators retain their existing semester controls. A requested teacher account does not gain teacher access until approved. Only an administrator changes a student's assigned semester.

This is an account-scope restriction, not a new privacy wall around public notes. Anonymous public reading remains available under the website's existing policy. Signing out does not make public content private.

## Connectivity and notifications

An internet connection is needed for notes, notices, messages, timetables, account actions, uploads, and downloads. The home-screen app's service worker stores only a fixed public connection screen, its stylesheet, and app icons. It does not store API responses, account state, chats, notes, notice attachments, signed download URLs, or private backups in Cache Storage.

The existing in-app notifications and verified, opted-in email delivery remain available. Account notifications refresh while the app is open; this release does not add operating-system push notifications or promise background polling when the phone suspends the app. Website updates use the browser's normal service-worker lifecycle rather than forcing a reload during a form or upload.

## Build and signing

The Android project pins Android Gradle Plugin `8.9.2`, Gradle `8.11.1`, compile/target SDK `35`, and Build Tools `35.0.0`. Use JDK 17 or a compatible newer JDK. The Android SDK license was accepted by the owner for the build tools used in this task.

See [the Android build guide](mobile/android/README.md) for the build commands and the `CLASSNEST_KEYSTORE`, `CLASSNEST_KEYSTORE_PASSWORD`, `CLASSNEST_KEY_ALIAS`, and `CLASSNEST_KEY_PASSWORD` environment variables. Signing values and the private release keystore stay outside the source repository and public archives. This build's private key is under `%USERPROFILE%/.classnest/android-signing/`; its password is protected using Windows user-bound DPAPI encryption. Future APK updates must retain the same signing key; keep a private backup of it.

The distributable is a signed, non-debuggable release APK. `assembleRelease` and `lintRelease` succeeded. Lint returned zero errors and two reviewed warnings: the guarded Back callback attribute is ignored below API 33, and JavaScript is required for this strictly restricted first-party WebView. The URL-policy harness passed all 57 checks. `apksigner` verified the v2 signature, and the 16 KiB alignment check passed. The signing certificate's SHA-256 fingerprint is `0adf108926cd4c45118e389a4069c950cbc6f2579ea40b7401c8e35451dcaf7d`. The package requests only Internet permission. A signed APK does not establish an approved store release.

## Verification boundary

All 108 website tests passed with zero failures. They cover service-worker cache boundaries, installation behavior, backend semester authorization, and frontend scope changes alongside the existing classroom workflows. Local browser checks verified installation guidance and layouts at 320, 390, and 430 pixels; the small-screen toolbar overflow was corrected. A signed-in Semester 3 student opened a Semester 4 URL and remained in Semester 3, with one disabled semester option and a normalized URL. Android build, lint, signing, and alignment checks passed as recorded above.

Production deployment `dpl_9ohMbPv9WxytCDTHMTv2zNNtL1Pe` is READY. The homepage, state, mobile assets, and public APK returned 200; served source and APK byte hashes matched the tested files. Existing public class content, three accounts, one approved teacher, and one routine were preserved, and the automatic worker returned 200 after deployment. Authenticated student operations were tested locally; no production student account or class post was created or modified for verification.

The live installation guide opened from the anonymous Subject library. Its Android/iPhone instructions expanded correctly, and **Download Android APK** linked to the exact public GitHub artifact. This verifies the live guide and link, not installation on a physical phone.

No physical Android phone or iPhone installation has been verified in this workspace. Device-specific file pickers, downloaded-file opening, and standalone sign-in should be checked on the intended phones before a broad class rollout.

## Hosting and source

Hosting configuration stays in [HOSTING.md](HOSTING.md). The website continues to use its existing Vercel, Supabase, and email services. Mobile source is under the Classnest folder in the existing `boce-chat` repository; adding it does not connect Vercel to Git or enable automatic deployment. The complete backup ZIP and repository inventory contain 130 files: 127 source files and three public Android release artifacts, including the APK. Private signing material, cloud content, SDKs, dependency/build directories, and environment files are excluded.

References: [web app installation](https://web.dev/learn/pwa/installation/), [Apple home-screen instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios), [Android WebView](https://developer.android.com/develop/ui/views/layout/webapps/webview), [Android signing](https://developer.android.com/studio/publish/app-signing), and [SDK terms](https://developer.android.com/studio/terms).
