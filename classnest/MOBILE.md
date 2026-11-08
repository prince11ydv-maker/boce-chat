# Classnest on Android and iPhone

Website: **https://pusoe.vercel.app**. The Android client, free home-screen app, and website share the same accounts and semester permissions. Current deployment evidence is in [DEPLOYMENT.md](DEPLOYMENT.md).

## Install the free home-screen app

- **Android:** open Classnest in Chrome, choose **Install Classnest**, and confirm. The browser menu's **Install app** or **Add to Home screen** is a fallback.
- **iPhone or iPad:** open Classnest in Safari, tap **Share → Add to Home Screen**, keep **Open as Web App** enabled if shown, and tap **Add**.

Open the new icon and sign in. Installed apps and ordinary browser tabs can keep separate sessions. No App Store or Google Play developer account is required for this installation.

## Android APK

Download [Classnest 1.1.0](mobile/releases/Classnest-1.1.0.apk), or use the [public GitHub download](https://github.com/prince11ydv-maker/boce-chat/raw/refs/heads/main/classnest/mobile/releases/Classnest-1.1.0.apk). Verify it against [its SHA-256 checksum](mobile/releases/Classnest-1.1.0.apk.sha256). Android may ask you to allow installation from your browser or file manager.

The client supports **Android 8.0 and newer**, application ID `app.classnest.pusoe`, version `1.1.0`, version code `2`. It opens the canonical HTTPS Classnest website in a restricted WebView, with native file selection, authenticated attachment downloads, Back navigation, connection/retry screens, and an app menu. Version 1.1.0 adds opt-in phone alerts through Firebase Cloud Messaging (FCM).

Install 1.1.0 over 1.0.0 using the same signing certificate to retain app data. The old [1.0.0 APK](mobile/releases/Classnest-1.0.0.apk) remains available but has no native phone alerts. Website updates appear when the latest page loads; native changes require a new APK with a higher version code. Automatic APK updates and store publication are not included. An APK cannot be installed on an iPhone.

## Semester access

Class content requires sign-in. Guests see a welcome screen without class notes, notices, conversations, timetables, or files. Students see only the semester assigned by the administrator, including when a link requests another semester. The server checks current membership for class content, note/notice files, and posting actions. The semester selector cannot change a student's membership.

Approved teachers can choose multiple teaching semesters. Their scope combines those choices with active class assignments, and their dashboard shows their own classes and materials. Pending teacher requests do not gain approved teacher posting access. Administrators manage all semesters and student assignments. These rules apply to the website, home-screen app, and APK.

Approved teachers can post semester announcements with supported photos or PDFs. They can edit or delete their own announcements within their current teaching scope; administrators can manage every announcement. Initial publication creates semester-scoped account alerts and opted-in emails. Ordinary edits do not send another announcement.

## Turn on phone alerts

**Android APK:** sign in to an approved account, open the native app menu (⋮), choose **Enable phone alerts**, and continue. Android 13+ requests notification permission. Older versions use the app's notification settings. Turn alerts off from the same menu. The app reconnects its registration to the current login while open; signing out removes the server's session-bound registration.

**Home-screen app or supported browser:** open **Notifications**, enable phone alerts, and approve the browser request. On iPhone/iPad, use the installed home-screen app on iOS/iPadOS **16.4 or newer**; an ordinary Safari tab cannot enable these alerts. Each installation or browser needs its own permission.

Alerts cover new notes, teacher/admin announcements, daily routine updates, and existing class-status/reminder events according to current semester membership and class assignments. Teacher reminders are generated three minutes before their assigned class. Alert text is generic; open the authenticated app for details. Email preferences remain separate and require verified, opted-in email.

Native Android alerts require Google Play services and configured Firebase server credentials. Web alerts require configured Web Push credentials and a supported browser. Permission and internet access are required. Focus modes, battery restrictions, manufacturer settings, force-stopping the app, and provider delays can prevent or delay an alert. This is not an exact alarm or guaranteed delivery at a particular second.

The APK contains public Firebase Android client configuration. Backend authorization uses a separate private server credential, now configured in Vercel. Google OAuth and a delivery-free FCM authorization check passed. Building the APK does not prove real phone delivery; complete a device test after server setup.

## Files, connectivity, and privacy

Uploads use Android's document picker without broad storage permission. Backend file validation and size limits still apply. Native downloads authorize the exact first-party attachment URL with the current session, then validate the project's signed storage URL. Cookies and Authorization headers never reach Supabase or DownloadManager. Signed URLs expire quickly; retry **Download** if a queued transfer starts too late.

Android 10+ saves to public Downloads. Android 8/9 uses app-specific Downloads; copy important files before uninstalling. Browser-generated exports such as calendar files and administrator backups use **Open in browser** and may need a separate sign-in.

Class content and account actions need internet. The service worker caches only its public offline screen, stylesheet, and four icons. It does not cache APIs, accounts, notes, chats, notice files, signed URLs, or backups. Push handling does not add offline class content. Normal service-worker updates preserve open forms and uploads.

## Build and signing

See [the Android build guide](mobile/android/README.md). The project pins Android Gradle Plugin `8.9.2`, Gradle `8.11.1`, compile/target SDK `35`, and Firebase Messaging `26.0.1`. It uses JDK 17 and the SDK license already accepted by the owner. Firebase includes AndroidX dependencies; no Analytics library is added.

The private release key stays under `%USERPROFILE%/.classnest/android-signing/`, outside GitHub, Desktop copies, and public archives. Its password uses Windows user-bound DPAPI encryption. Keep a private backup: future updates must use the same certificate. Certificate SHA-256: `0adf108926cd4c45118e389a4069c950cbc6f2579ea40b7401c8e35451dcaf7d`.

Compilation, release lint, 72 pure-Java URL-policy checks, signature verification, and alignment results are recorded with the [release artifact](mobile/releases/README.md). Notification links accept only a canonical inbox destination with a valid semester. The app has no JavaScript bridge or TLS-error bypass. Notification permission is opt-in; no camera, microphone, or broad storage permission is requested.

## Verification boundary and source

Backend/browser tests cover semester isolation, teacher ownership, announcement recipients, and account transitions. Website test and production results are in [DEPLOYMENT.md](DEPLOYMENT.md). Compilation and static checks do not establish physical-phone installation or delivery.

Before broad rollout, test Android/iPhone installation, login, semester restrictions, uploads/downloads, and real notifications with the app closed. Also test permission denial, opt-out, logout/account switching, and a teacher reminder. No physical phone installation or push delivery has been verified in this workspace.

Hosting remains on the existing Vercel/Supabase services; see [HOSTING.md](HOSTING.md). The repository/source ZIP use the explicit allowlist in `scripts/package.ps1`, including mobile source, public Firebase client configuration, release APKs, and checksums. Private signing keys, server credentials, cloud data, SDKs, dependencies, and build directories are excluded. Source changes do not automatically deploy the website.

References: [web installation](https://web.dev/learn/pwa/installation/), [Apple home-screen installation](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios), [Apple Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers), [Firebase Android setup](https://firebase.google.com/docs/cloud-messaging/android/get-started), [Firebase message handling](https://firebase.google.com/docs/cloud-messaging/android/receive-messages), [Android signing](https://developer.android.com/studio/publish/app-signing).
