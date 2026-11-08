# Classnest Android APK

[Download Classnest 1.0.0](Classnest-1.0.0.apk) for Android 8.0 and newer. This is a signed, non-debuggable release client for https://pusoe.vercel.app. It needs an internet connection and uses the existing website accounts.

The APK is for Android; iPhone and iPad use the free home-screen app described in [MOBILE.md](../../MOBILE.md). No store publication is claimed.

Package: `app.classnest.pusoe`; version code: `1`; target SDK: `35`. The APK SHA-256 is recorded in [the checksum file](Classnest-1.0.0.apk.sha256). Signing certificate SHA-256: `0adf108926cd4c45118e389a4069c950cbc6f2579ea40b7401c8e35451dcaf7d`.

Android compilation, release lint (zero errors; two reviewed platform/JavaScript warnings), signature and alignment verification, and 57 URL policy checks passed. Physical phone installation and device-specific file handling have not been tested in this workspace.

The private signing key is kept outside this repository. Native source and build instructions are in [mobile/android](../android/README.md). Future native updates need the same key and a higher version code.
