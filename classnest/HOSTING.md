# Classnest hosting guide

Live website: **[pusoe.vercel.app](https://pusoe.vercel.app)**.

The application source lives in this repository's `classnest/` folder. Run its commands from that folder; the repository's root application is a separate project.

## Current hosting

| Component | Existing service |
| --- | --- |
| Web server | Vercel Hobby, Express, Node.js 24, Mumbai (`bom1`) |
| Database | Supabase Free PostgreSQL, Mumbai (`ap-south-1`) |
| Attachments | Private Supabase bucket `classnest-attachments` |
| Account and notification email | Brevo SMTP |
| Retry and class-reminder worker | Existing Supabase cron job `classnest-email-delivery`, every minute |
| Browser/PWA phone alerts | Standard Web Push with server-side VAPID keys |
| Native Android alerts | Firebase Spark project `classnest-pu-soe`; private server credential configured and OAuth/FCM authorization checked |

Latest WhatsApp/support-recovery source update: **147 website tests passed**. The release is READY in production: deployment `dpl_7p1QeXUcWzEbPCWgur74LRV1tBws`, source SHA-256 `114bc5075103a10392335b7d563e4a8e02e19ad3d9141fbb3f9bec72e8c15ba4`. Browser QA covered support forms/navigation; temporary-password transitions were exercised with synthetic HTTP accounts, without resetting a real production account. The earlier address, `classnest-pu.vercel.app`, continues to redirect to the primary website. Physical-device installation and notification delivery remain separate checks.

Historical preceding privacy/mobile/announcement/push release: deployment `dpl_4khExEGH8KKJcgZaXNpgnrj84gUw`, source SHA-256 `fbcee2715844d9fa3b6d90f8b5cfe158a6315c2ec82500d148106847c6fef754`, 131 tests, READY production source/access/data-preservation and worker checks. Those facts describe that earlier release.

The preceding mobile/student-lock deployment was `dpl_9ohMbPv9WxytCDTHMTv2zNNtL1Pe`, READY with SHA-256 `f79380302ac75c22888aba88f92692aaa4055a3cf6a25a83b6da889466fa2c4e` across 54 source files. Its 108 website tests, Android build/signature checks, production checks, and automatic worker run remain historical evidence in [DEPLOYMENT.md](DEPLOYMENT.md); they do not establish delivery through the new phone channels.

Mobile installation is documented separately in [MOBILE.md](MOBILE.md). The Android/iPhone home-screen app and signed APK use the same HTTPS site/backend. The current source wraps header controls on narrow screens and gates class content behind sign-in: students have one administrator-assigned semester; approved teachers have saved selections plus active assignments; admins have all semesters. Guests receive only branding/signup options and a gateway, with no class payload. Existing accounts/content are not re-imported. Native signing material remains private and excluded from source archives; the APK is a public artifact, not a server credential.

Teachers can publish semester announcements within their allowed scope and manage their own notices; administrators retain full moderation. Both students in the scheduled class's semester and its assigned teacher get reminders targeted three minutes before class. The one-minute worker and provider/network conditions can delay arrival. Phone, email, and account notifications are separate channels.

Adding this source to GitHub does not connect the existing Vercel project to Git or turn on automatic deployments. It requires no new service, paid plan, credential, or deployment. The current website continues to use its existing provider settings.

## Run or deploy the source

Approved accounts are required for class content. Pending accounts see an awaiting-approval screen; blocked accounts see a contact-administrator screen. Both retain their own account settings, help, status refresh, and sign-out controls, but receive no notes, notices, routines, discussions, files, or teaching data—even in their requested semester. Registering another unapproved account therefore does not open another class.

Use Node.js 24 and run:

```sh
cd classnest
npm ci
npm test
npm start
```

`npm ci` runs `build-assets.mjs` to generate the self-hosted PDF.js browser assets from the lockfile. Generated assets and `node_modules` are recreated during installation. Local development defaults to SQLite and local attachment storage; production uses the configured cloud services.

If this repository is later imported or linked in Vercel, select **Root Directory: `classnest`**, the Express framework, and Node.js 24. Keep the existing production environment and database when updating the current project. [FREE-HOSTING.md](FREE-HOSTING.md) contains the full platform setup; [DEPLOYMENT.md](DEPLOYMENT.md) contains release evidence and verification boundaries.

## Configuration kept in Vercel

The entries below describe settings; they contain no credentials. Retain the current values in the provider dashboard. Secrets belong in the server's production environment, never in Git, frontend files, or a source ZIP.

| Variable | Value or description |
| --- | --- |
| `NODE_ENV` | `production` |
| `DB_PROVIDER` | `postgres` |
| `DATABASE_URL` | Secret transaction-pooler URL for the restricted `classnest_app` account |
| `PG_CA_CERT` | Supabase database root CA PEM; certificate verification stays enabled |
| `STORAGE_PROVIDER` | `supabase` |
| `SUPABASE_URL` | Existing project's HTTPS URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret server storage key |
| `PUBLIC_ORIGIN` | `https://pusoe.vercel.app` |
| `ALLOWED_HOSTS` | `classnest-pu.vercel.app,pusoe.vercel.app` |
| `EMAIL_ENABLED` | `true` for the existing verified SMTP setup |
| `MAIL_HOST` | `smtp-relay.brevo.com` |
| `MAIL_PORT` | Existing TLS/STARTTLS port, normally `587` |
| `MAIL_USER` | Brevo SMTP login |
| `MAIL_PASSWORD` | Secret dedicated SMTP key |
| `MAIL_FROM` | Existing verified sender address |
| `MAIL_FROM_NAME` | `Classnest` |
| `EMAIL_ENCRYPTION_KEY` | Existing independent 32-byte hex Secret |
| `EMAIL_CRON_SECRET` | Existing independent 32-byte hex worker Secret |
| `PUSH_VAPID_PUBLIC_KEY` | Configured Web Push public key; returned only as needed by the approved client's setup |
| `PUSH_VAPID_PRIVATE_KEY` | Matching server-only VAPID private key; Secret |
| `PUSH_VAPID_SUBJECT` | VAPID contact, such as `mailto:prince11ydv@gmail.com` |
| `PUSH_ENCRYPTION_KEY` | Optional independent 32-byte hex Secret for stored device payloads; the module otherwise uses the existing `EMAIL_ENCRYPTION_KEY` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Server-only Firebase service-account JSON for native Android FCM; configured privately; never part of the APK or browser bundle |

Keep the encryption and worker secrets stable across deployments. [EMAIL-SETUP.md](EMAIL-SETUP.md) explains sender verification, consent, queue budgets, and the authenticated worker. Changing a domain requires coordinated origin, redirect, and queued-email handling as described there.

## Support and assisted password recovery

The primary support contact is [WhatsApp · +977 9763214754](https://wa.me/9779763214754), available in the footer, FAQs, account/recovery screens, and Android 1.1.1 app menu. This is a user-opened link with no automatic message or account details. It does not replace the configured Brevo sender, reset emails, VAPID contact, or notification preferences, and requires no WhatsApp API credential or paid integration.

The existing **Sign in → Forgot password?** email flow stays available. **Request admin help** accepts an email and optional 500-character message with a generic acknowledgement. Administrators use **Manage workspace → Password help requests**, verify the person independently, record the check, and reauthenticate with their own current password for both verification and reset. The same administrator has 30 minutes to complete a verified reset. A temporary password expires after 24 hours, revokes existing sessions/device bindings, and requires personal-password change before class or administrator tools open. Pending/blocked restrictions, account role, semester and email preferences remain unchanged. Do not ask for an old user password or verification code. Self-service changes continue through Account → Change password.

The new `password-support.js` module uses owner-run `schema/password-support-postgres.sql`, applied in production as `classnest_admin_password_support`. Its request table has RLS, restricted-server CRUD only, zero browser-role/PUBLIC grants, and zero Supabase security-advisor findings. SQLite automatically initializes `schema/password-support-sqlite.sql`. Support requests and verification notes stay out of portable class exports; temporary account hash markers/expiry survive export/import. No account re-import, runtime PostgreSQL DDL, extra environment variable, or new hosting resource is needed.

The current 147-test suite covers acknowledgement/throttling, impersonation, reauthentication, stale-session/password and replay denial, temporary expiry/forced change, approval preservation, portable hashes, escaped private queue rendering, frontend secret clearing, and gated class/push views. Browser form checks do not imply a real production password was reset.

## Phone-alert setup, user consent, and reversal

The signed Android 1.1.1 APK is version code 3, package `app.classnest.pusoe`, for Android 8.0+ (minimum SDK 26, target SDK 35). It is 2,852,715 bytes; SHA-256 `0290fcfe2810b12b585c6cfc3e83b9d76e88e5e12bc5153ed67898215c03a859`. Build/lint, v2 signature, 16 KiB alignment and 72 URL-policy checks passed. Its WhatsApp menu is manual and its phone-alert path remains opt-in. Download and checksum links are in [MOBILE.md](MOBILE.md); installation and receipt on a physical phone remain unverified.

Web Push VAPID configuration is saved on the server, and `schema/push-postgres.sql` is applied with RLS/server-only permissions. The security advisor returned zero findings after that migration. Web clients use the standard Push API and the same-origin service worker; the website does not load a Firebase browser SDK. Free Firebase Spark project `classnest-pu-soe` has been created for the native Android channel. Its private service-account credential is saved only in the production server environment. Google OAuth and a delivery-free FCM validation request passed; actual device receipt remains unverified. The current Android 1.1.1 client supports that channel on devices with Google Play Services.

Approved users open **Notifications → Enable phone alerts** and accept their own browser/OS permission prompt. The site never prompts or subscribes on load. Compatible Android/desktop browsers can use Web Push; iPhone/iPad needs iOS/iPadOS 16.4 or later and Safari **Share → Add to Home Screen**, followed by opening that installed app and signing in. Android APK users use **Enable phone alerts** in the native app menu. An installed PWA with a waiting service-worker update may need to be closed and reopened. OS permissions and provider/network state affect delivery; no exact-time or real-device receipt claim is made without a device test.

Devices are bound to the existing account and current login session. The server rechecks session, approval, semester access, and notification validity before sending. Logout, session expiry, or password/session revocation invalidates the binding. A new login needs manual enablement again; the client never silently recreates a subscription. The lock screen displays only a fixed generic class-update message. Clicks navigate to a same-origin opaque notification ID, whose content is looked up after the correct account signs in. Account/private API responses and attachments are never added to the offline cache.

Users can choose **Disable on this browser**, which removes current-login web devices and unsubscribes that browser. Native users can disable app notifications through Android settings. For a server rollback, remove both VAPID key variables together and redeploy to turn off the Web Push channel; remove the Firebase service-account Secret and redeploy to turn off native FCM. Keep a paired VAPID configuration when enabled: a partial or mismatched pair fails startup. These changes leave ordinary account/email notifications available. Do not rotate the device encryption key casually while encrypted records exist; drain/remove affected devices and require fresh opt-in when replacing it. No key, token, device endpoint, or subscription payload belongs in source, logs, chat, or a source ZIP.

## Database migrations and persistent content

The current production database already has the documented migrations. Updating source does not require re-importing accounts, rebuilding tables, or copying uploads. Accounts, passwords, notes, notices, routines, sessions, and attachment bytes remain persistent cloud content; they are not stored in this repository. Back them up separately and privately.

For a genuinely new, empty PostgreSQL project, follow [FREE-HOSTING.md](FREE-HOSTING.md). Start with `schema/postgres.sql` and `schema/postgres-runtime.sql`, configure the restricted account's password privately, then apply the additive schemas in dependency order:

1. `schema/email-postgres.sql`
2. `schema/semester-postgres.sql`
3. `schema/routines-postgres.sql`
4. `schema/teacher-accounts-postgres.sql`
5. `schema/teaching-postgres.sql`
6. `schema/teacher-semesters-postgres.sql`
7. `schema/notice-attachments-postgres.sql`
8. `schema/push-postgres.sql`
9. `schema/class-reminders-postgres.sql`
10. `schema/password-support-postgres.sql`

Create the private attachment bucket and initialize or import the intended workspace only through the documented setup procedure. Imports refuse occupied targets. After the worker route is live and its secret is stored in Supabase Vault, follow [EMAIL-SETUP.md](EMAIL-SETUP.md) for `schema/email-worker-postgres.sql` and `schema/teaching-worker-postgres.sql`. They configure one existing delivery job, not a second scheduler. Never run the initial schema or an import over the current production database.

The files in [AZURE-HOSTING.md](AZURE-HOSTING.md) and `scripts/azure/` are retained legacy hosting material. The live website runs on Vercel and Supabase; the newer teaching and notice workflows are documented and verified for SQLite/PostgreSQL.

## Private Firebase backup on the owner's Desktop

The `Classnest-Website-Source-2026-11-08` Desktop folder has a separate `PRIVATE-Firebase-Admin/` folder beside the publishable `classnest/` project. It holds the owner's original downloaded Firebase admin JSON and a private-use guide. This folder is excluded from Git and both source ZIPs. The mobile source copy points to this single private backup rather than duplicating the credential.

Use the admin JSON only for the server's private `FIREBASE_SERVICE_ACCOUNT_JSON` configuration. It is different from `mobile/android/firebase-client.json`, which contains public client identifiers and belongs in the app source. Never put the admin JSON in the APK, browser files, GitHub, or public source archives. Firebase admin and service-account filenames are ignored by the project as an extra safeguard.

Historical database downloads are organized separately under `PRIVATE-Database-Backups/`, in dated folders beside `classnest/`. These private folders and SQLite/database filenames are ignored by Git and excluded from the source ZIPs. Each backup has a private inventory and integrity record. A SQLite snapshot contains database records, not uploaded attachment bytes; preserve the matching files separately. Test restoration using a working copy and the appropriate schema/migration procedure before using an old snapshot. The portable JSON importer does not accept a raw SQLite file.
