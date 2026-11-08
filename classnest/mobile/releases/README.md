# Classnest Android APK

[Download Classnest 1.1.1](Classnest-1.1.1.apk) for Android 8.0 and newer. This signed, non-debuggable client opens https://pusoe.vercel.app and uses the existing accounts and semester restrictions. Install it over an existing Classnest installation to keep app data.

Version 1.1.1 adds **WhatsApp support** in the native menu, opening `https://wa.me/9779763214754` externally without sending a message or including account details. It retains opt-in phone alerts introduced in 1.1.0. Sign in to an approved account, open the app menu (⋮), and choose **Enable phone alerts**. Google Play services, permission, internet, and configured backend Firebase credentials are required. Android or provider restrictions can delay or prevent delivery. Phone alerts have generic text; opening the app still requires authorization for class details.

The APK is for Android. iPhone/iPad users use the free home-screen app described in [MOBILE.md](../../MOBILE.md). No store publication or physical-phone delivery is claimed.

- Package: `app.classnest.pusoe`.
- Version: `1.1.1`; version code: `3`; minimum SDK: `26`; target SDK: `35`.
- APK size: **2,852,715 bytes**.
- SHA-256: `0290fcfe2810b12b585c6cfc3e83b9d76e88e5e12bc5153ed67898215c03a859`, also in [the checksum file](Classnest-1.1.1.apk.sha256).
- Signing certificate SHA-256: `0adf108926cd4c45118e389a4069c950cbc6f2579ea40b7401c8e35451dcaf7d` (same certificate as 1.0.0).
- Public Firebase Android client configuration is compiled in; `FIREBASE_CONFIGURED=true`.

Release compilation, lint, all 72 URL-policy checks, APK v2 signature verification, and 16 KiB ZIP alignment verification passed. Lint has zero errors and four reviewed warnings: the guarded API 33 Back attribute, JavaScript required by the restricted first-party WebView, and two duplicate unused-resource warnings for Firebase's dynamically read `project_id` string. The compiled manifest is non-debuggable.

Permissions are Internet, opt-in notifications, network state, wake lock, Firebase's protected cloud-messaging receiver, and the app's non-exported dynamic receiver permission. No camera, microphone, broad storage, or advertising-ID permission is present. Private signing/server credentials are absent from the APK and source archive.

Source and build instructions are in [mobile/android](../android/README.md). Future native updates require the same private signing key and a higher version code. Building an APK does not verify installation or delivery on a physical phone; run the device checks in [MOBILE.md](../../MOBILE.md) before wide distribution.

The previous [Classnest 1.1.0](Classnest-1.1.0.apk) and [its checksum](Classnest-1.1.0.apk.sha256) remain available with phone-alert support but without the native WhatsApp menu. The older [Classnest 1.0.0](Classnest-1.0.0.apk) and [its checksum](Classnest-1.0.0.apk.sha256) remain for compatibility. The 1.0.0 build opens the same remote website but has no native phone-alert support.
