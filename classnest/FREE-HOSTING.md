# Classnest on Vercel Hobby and Supabase Free

The Express app runs on Vercel in Mumbai. Supabase in Mumbai stores the PostgreSQL database and private attachments. Local development still uses SQLite and `data/uploads`.

Latest support/recovery source update: **147 website tests passed**; publication pending as deployment `dpl_7p1QeXUcWzEbPCWgur74LRV1tBws`, source SHA-256 `114bc5075103a10392335b7d563e4a8e02e19ad3d9141fbb3f9bec72e8c15ba4`. It adds manual WhatsApp support at +977 9763214754 and administrator-assisted recovery alongside the existing email reset. Browser QA covered the forms/navigation; temporary-password transitions were tested with synthetic HTTP accounts, without resetting a real production account. Android 1.1.1 (code 3) adds the native WhatsApp menu and retains phone alerts; physical-device installation/delivery remains unverified.

## Earlier releases (historical)

The preceding privacy/announcement/reminder/push release reached READY as deployment `dpl_4khExEGH8KKJcgZaXNpgnrj84gUw`, source SHA-256 `fbcee2715844d9fa3b6d90f8b5cfe158a6315c2ec82500d148106847c6fef754`, with 131 tests and production source/worker checks. Its sign-in gateway, semester privacy, wrapping header, teacher announcements, three-minute student reminders and opt-in phone channels remain in the current source. These release facts are historical; they do not establish actual phone delivery.

The preceding mobile/student-lock release reached READY with 108 website tests, 57 Android URL-policy checks, release build/lint, APK signature/alignment checks, and production checks. It preserved the then-public class content and existing accounts. Its Android 1.0.0 installation evidence is in [MOBILE.md](MOBILE.md); newer phone-alert support is documented below.

That earlier release cached only fixed public offline-screen/icon assets and retained guest public reading; it did not add operating-system push. The current source closes the guest content bypass and adds the opt-in channels below. The worker still never caches class/account content, files, or API responses; internet remains required.

The earlier 8 November teacher dashboard and multiple-semester profile release reached READY on the existing free hosting. All 71 automated tests and local browser workflows passed. Its production frontend files matched the tested source, live signup permitted multiple teacher-semester selections, and anonymous private-route requests were rejected. Public state stayed available, the original weekly routine was preserved, and the exam section stayed empty. The real teacher account was preserved. The existing worker job remains active every minute. Release identifiers and the local/private-dashboard verification boundary are recorded in [DEPLOYMENT.md](DEPLOYMENT.md).

The later notice attachment and direct-alert update is READY in production with all 88 automated tests passing. Its cloud migration/security checks, local photo/PDF publication/rendering and student alert links, and production source/content/access checks passed. The automatic worker returned 200 with the new cleanup queries, and public class content was preserved. Authenticated posting and alert navigation were tested locally; production verification introduced no QA post or notice email. It reuses the existing private bucket, 700 MiB shared note/notice allowance, SMTP sender, and worker; no additional hosting resource, credential, or paid service is required.

In those earlier releases, profile choices did not grant account approval, class assignments, private-notification scope, or discussion access. Those private boundaries remain in the current source; saved/assigned choices now also determine a teacher's class-library scope.

The earlier semester update preserved existing accounts, sessions, and class content. Its separate live semester-access checks remain documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Current access and phone alerts

Approved accounts are required for class content. Pending accounts see an awaiting-approval screen; blocked accounts see a contact-administrator screen. Both retain their own account settings, help, status refresh, and sign-out controls, but receive no notes, notices, routines, discussions, files, or teaching data—even in their requested semester. Registering another unapproved account therefore does not open another class.

Class content requires sign-in. Guest state returns branding and signup semester choices with empty class-content arrays and no routine or teaching data. Students can read and contribute only in their primary assigned semester. Approved teachers use saved selections plus active assignments, with a primary-semester fallback; administrators see all semesters. Private discussions/notifications retain their separate primary/actual-assignment rules. Frontend account changes and scope reductions discard stale pages/previews.

Approved teachers can publish a notice to an allowed semester and edit/delete only their own notices. Administrators retain full notice moderation and pinning. Creation sends scoped account alerts; editing preserves its attachment/semester without rebroadcast. Both approved students and assigned teachers have scheduled-class reminders targeted three minutes before class. The minute worker and provider/network conditions affect actual timing.

The primary address is **https://pusoe.vercel.app**. The previous address, https://classnest-pu.vercel.app, redirects with paths, queries, and email-link fragments preserved. Existing accounts stay in the same database; browser-local bookmarks/appearance remain scoped to each hostname.

Use free personal accounts. Vercel Hobby is for personal, noncommercial use. Supabase Free currently includes 500 MB database storage and 1 GB file storage, with usage limits and inactivity pausing. No paid upgrade or add-on is required. Check the providers’ dashboards for current usage.

## Runtime settings

Configure these as production environment variables in Vercel:

- `NODE_ENV=production`
- `DB_PROVIDER=postgres`
- `DATABASE_URL`: Supabase Transaction pooler connection string, with the restricted `classnest_app.PROJECT_REF` username and its random password. Save as a Secret.
- `STORAGE_PROVIDER=supabase`
- `SUPABASE_URL`: the HTTPS project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: a server secret key or legacy service_role key. Save as a Secret; never put it in frontend code.
- `PUBLIC_ORIGIN=https://pusoe.vercel.app`: the exact canonical HTTPS origin for browser writes and email links. A hostname change requires a new deployment using the updated value.
- `ALLOWED_HOSTS=classnest-pu.vercel.app,pusoe.vercel.app`: retain both exact hosts while the old address redirects to the primary address. An allowed hostname alone does not change the browser mutation origin.
- `PG_CA_CERT`: the Supabase root CA PEM downloaded from Database Settings → SSL configuration. The shared pooler requires this trust anchor; certificate and hostname validation remain enabled.

Vercel’s system deployment and production hostnames are allowed automatically. Set `ALLOWED_HOSTS` only for additional exact custom hosts. Match the Supabase hostname in `vercel.json` when deploying a different project.

Appearance offers Light, Dark, and System. It defaults to following the device and saves the selected mode locally, with live device changes in System mode and synchronization across same-origin tabs. It needs no account or database change.

## Database and migration

Apply `schema/postgres.sql` to a new, empty project and `schema/postgres-runtime.sql` once to create the runtime role. Set its password separately through a private administrator connection. The app performs no runtime schema DDL. Tables have RLS enabled, no public/anon/authenticated grants, and policies only for the server role. Runtime writes use transaction-scoped advisory locking across all function instances.

Create the private `classnest-attachments` storage bucket with a 20 MiB per-file limit and no public upload/read policies. Use the Storage API for file uploads; copying `storage.objects` rows does not copy file bytes.

Export the local SQLite data using `scripts/migrate-data.mjs export` to the private workspace `work/` directory. Import only into an empty target. Preserve existing IDs and password hashes; omit active sessions and throttling records. Copy each referenced attachment to `notes/FILENAME` with the Storage API and compare SHA-256 hashes before publishing. Keep original data until migration is verified.

The email update adds `schema/email-postgres.sql` to the existing project. It creates private RLS-protected reset, verification, preferences, encrypted-outbox, and budget tables without replacing accounts or password hashes. SQLite initializes its email tables automatically.

### Account-semester update

For an existing PostgreSQL project, use the owner-run `schema/semester-postgres.sql` migration. First release a compatibility build with explicit six-column user inserts and qualified semester references in joined notices/discussion queries; adding `users.semester` would otherwise break positional inserts or make those joins ambiguous in an older build. Then add the nullable foreign-key column and backfill existing accounts from the current workspace semester, deploy the semester-aware release, and rerun the null-only backfill to catch registrations during the transition. The current workspace's existing accounts are assigned Semester 3. Account IDs, password hashes, sessions, and content stay in place; no re-import is performed.

PostgreSQL's restricted runtime role performs no schema DDL. Local SQLite initializes or adds the column automatically and backfills existing accounts. The retained Azure SQL path has the separate owner-run `schema/semester-azure-sql.sql` migration; this does not establish a live Azure deployment. Portable imports accept older user rows without a semester and normalize them to the exported workspace's valid semester, while preserving IDs and password hashes.

Registration requires a valid account semester. Notes, notices, routines, previews, and downloads require a signed-in account in the allowed semester scope. Students cannot use guest browsing, forged query values, or another account's file link to view other-semester content. Approved teacher library scope is saved selections plus active assignments; primary private discussion rules remain separate. Only administrators change primary account assignment. Email profile preferences do not change membership.

### Teacher accounts and daily timetables

Existing PostgreSQL installations need the additive owner-run `schema/teacher-accounts-postgres.sql` and `schema/teaching-postgres.sql` migrations. They are applied in production as `classnest_teacher_accounts` and `classnest_teaching_workflows`. The first adds the requested account type, approved teacher role, and teacher reminder preference. The second adds teacher_slots, daily_routines, class_occurrences, and app_notifications, with RLS, server-only CRUD policies, and no browser Data API grants. The post-migration security advisor returned no findings. The original two users, one subject, and one routine were preserved. SQLite initializes its matching schema locally. New teacher/daily migrations are supplied for SQLite/PostgreSQL; the retained legacy Azure adapter is not a verified implementation of these new workflows.

Teacher signup remains pending until an administrator approves the account. Approve real teachers in Manage workspace, then assign teacher, subject, weekday, 24-hour Nepal start/end time, and room in Teaching & my notes. No approved production teachers existed during the 7 November release verification; a real teacher joined during the 8 November dashboard update and was preserved. The imported PDF grid does not identify account IDs; no teacher identities, emails, or mappings are generated from it.

Daily plans appear before the weekly routine. Admins choose a date, enter structured classes or prefill that weekday's assignments, and publish. A daily plan overrides weekly teacher assignments for that date; publishing an empty plan means no classes. The date view spans seven days in the past through thirty days ahead, with 35-day daily/occurrence retention. Existing weekly/exam editors and HTML-table imports stay available. Note authors can edit their title, subject, and content through My notes, with existing attachments retained; administrators can edit any note.

Account alerts cover notes, notices, daily changes, teacher responses, and scheduled-class reminders. Students receive their current semester's updates; teachers retain private assignment/primary scopes and own reminders. The existing delivery worker checks every minute and targets reminders three minutes before class for approved students and assigned teachers. Email still requires verified/category consent, with a separate teacher reminder choice. Open pages refresh account alerts about every 60 seconds. Opt-in phone delivery uses the channels below; neither polling nor push guarantees exact arrival time.

Authorized signed-in daily boards show Pending/Coming/Not coming and arrival bands; explanations remain limited to authorized views and private class notifications. Teachers choose 1–5, 5–10, or 10+ minutes when coming, or give a reason when absent. The clock/date use Asia/Kathmandu.

### Teacher overview and multiple semesters

For this update, existing PostgreSQL projects need the additive owner-run `schema/teacher-semesters-postgres.sql` migration before the new server is deployed. It creates the `teacher_semesters` profile table with RLS, server-only CRUD policy, and no public Data API grants. It is applied in production as `classnest_teacher_semesters`; checks returned RLS enabled, zero public grants, and no security-advisor findings. SQLite initializes `schema/teacher-semesters-sqlite.sql` automatically. The earlier overview deployment reached READY; anonymous private requests were rejected and its then-public content was preserved.

Approved teachers get an overview of their own classes, unanswered replies, next 48 hours, weekly assignments, and notes. The class filter combines chosen semesters with real administrator assignments; choosing fewer semesters cannot hide an assigned class. Profile choices are separate from primary class membership and cannot authorize discussions, private absence reasons, notifications, or class assignments. Teacher notes are filtered by authorship, and the selected-semester note view bounds text separately. No new hosting resource, credential, worker, or paid upgrade is required.

Portable exports add `teacher_semesters` as the fourteenth durable table. Older exports without it remain accepted and start with no saved teacher choices; the dashboard then falls back to the account's primary semester. As before, import only into an empty target and preserve current accounts/content rather than re-importing over production.

### Notice attachments and direct alerts

For an existing installation, apply `schema/notice-attachments-postgres.sql` as the project owner before deploying the notice-aware code. It is applied in production as `classnest_notice_attachments`. It adds `notice_attachments` for durable one-file-per-notice metadata, `notice_uploads` for transient upload-purpose binding, and the notice app-notification type. Both new tables have RLS enabled, server-only CRUD policies, and zero grants to anon, authenticated, or PUBLIC. The Supabase security advisor returned no findings. Production retained three accounts, one approved teacher, one subject, no notes or notices, and one routine. SQLite initializes `schema/notice-attachments-sqlite.sql` locally. The earlier attachment deployment reached READY; its release evidence remains in [DEPLOYMENT.md](DEPLOYMENT.md).

Notice PDFs/photos are limited to 20 MiB each and share the same 700 MiB app attachment allowance with notes. Header/dimension validation uses pinned `image-size` 2.1.0. Allowed originals include PDF, JPG/JPEG, PNG, WebP, GIF, BMP, AVIF, HEIC/HEIF, and TIF/TIFF, with image bounds of 100 megapixels and 30,000 pixels per side. Browser-native previews use tighter 16-megapixel/12,000-pixel-per-side limits. HEIC/HEIF/TIFF and larger originals stay downloadable; PDFs use the existing bounded self-hosted viewer. Header checks do not establish full decoding or antivirus safety.

The private bucket and core nine-column upload ticket are reused. A purpose marker prevents note/notice ticket substitution. Completed notice tickets hold the core expiry past the legacy note-only sweeper, while markers retain their original expiry; new cleanup runs inside the shared write transaction and preserves any file referenced by either content type. The worker therefore reclaims staged/orphan data without letting an older cleanup path delete a published notice attachment. No storage credentials, SMTP key, delivery job, or provider change is required.

Notice publication creates scoped private account alerts, excluding the sender, with a direct `#notices/ID` link and semester context. Email copies use the verified, opted-in Notices category. The separate legacy notice-email enqueue is removed. Queued email rechecks current permission, consent, scope, and the notice's continued existence. Testing does not post a production notice or send a real production notice email.

### WhatsApp support and administrator-assisted recovery

The primary support link is [WhatsApp · +977 9763214754](https://wa.me/9779763214754). It opens WhatsApp for a user to write/send a message; there is no prefilled account data, automatic message, WhatsApp API, new paid service, or extra server credential. The existing Brevo email recovery and notification settings stay separate.

Apply owner-run `schema/password-support-postgres.sql` before deploying `password-support.js` and the support-aware server. Production has this additive migration as `classnest_admin_password_support`; RLS is enabled, the restricted server has CRUD, browser roles/PUBLIC have no table grants, and the Supabase security advisor returned zero findings. SQLite initializes the matching `schema/password-support-sqlite.sql`. No runtime PostgreSQL DDL or account re-import is required. Support requests/verification notes are operational private data and are excluded from portable class exports. Encoded temporary account hashes preserve their expiry/forced-change requirement during portable backup round-trips.

Users retain **Sign in → Forgot password?** (single-use 30-minute email link), with **Request admin help** as a fallback. The public email/message form always gives a generic acknowledgement. **Manage workspace → Password help requests** is administrator-only: independently verify the person, record the check, then reauthenticate again to set a temporary password. The same administrator must complete the reset within 30 minutes of verification. The temporary password expires in 24 hours; old sessions/device bindings are revoked, and personal-password change is mandatory before class/admin access. Approval, role, semester and email preferences remain unchanged. Account owners use normal password settings for their own changes. Never request an old user password or verification code.

### Phone delivery setup and limits

The additive owner-run `schema/push-postgres.sql` is applied with RLS, server-only table permissions, and zero security-advisor findings. It stores encrypted device subscriptions/tokens and durable delivery jobs bound to a live account session. The existing authenticated worker drains push after rechecking current ownership, permissions, and notification validity; browser clients receive only an opaque ID and fixed generic lock-screen text. Devices and queue records are transient, excluded from portable class backups.

Web Push VAPID keys are configured server-side. Compatible browsers/PWAs expose **Notifications → Enable phone alerts**; permission/subscription starts only from that button. iPhone/iPad requires iOS/iPadOS 16.4+ and Safari Add to Home Screen. An old installed worker may require closing/reopening the app to finish updating. The Android 1.1.1 native FCM path needs Google Play Services. Free Firebase Spark project `classnest-pu-soe` exists, and its private service-account setup is complete. Google OAuth and delivery-free FCM authorization checks passed; actual phone receipt remains unverified. No paid plan is enabled.

Signing out, session expiry, password/session revocation, or lost access invalidates the device binding. A new login needs manual enablement again; the client never silently resubscribes. **Disable on this browser** removes its current-login web devices and unsubscribes locally. Lock screens show no notice text, teacher explanation, or student detail; clicks resolve a same-origin notification ID after sign-in. Actual closed-app/lock-screen delivery still needs a supported-device test. Server variables and reversible provider controls are in [HOSTING.md](HOSTING.md).

### Class and exam routines

Apply owner-run `schema/routines-postgres.sql` before deploying the routine-aware server. It adds the semester/kind-keyed `routines` table with RLS, no public/anon/authenticated grants, and CRUD access only for `classnest_app`. The production `classnest_routine_tables` migration is applied; checks found zero public grants and no security-advisor findings. The server performs no PostgreSQL schema DDL. Existing SQLite databases create the corresponding table automatically; the retained Azure SQL path has its separate routine migration.

The signed-in homepage shows the allowed semester's weekly class and exam routines. Only administrators publish changes. Limits remain 12 columns, 40 rows, 160-character cells, 80-character headings/titles, and 100 KiB serialized content. Revision checks reject stale saves. Exam routines stay empty until published; resetting retains the increasing revision.

Current portable-v1 backups have fifteen durable tables, adding notice attachment metadata to routines, teaching collections, and teacher semester-profile choices. Older nine-, ten-, thirteen-, and fourteen-table exports remain supported and gain empty missing collections; account types normalize to student unless an existing teacher role identifies the account. App-notification inboxes, sessions, notice upload markers, email tokens, email preferences, outbox content, password-help requests/verification notes, and secrets are omitted. File bytes must be backed up separately from metadata. Imports validate structure, references, dates, revisions, duplicate keys, and note/notice filename aliases, and refuse occupied targets. Class occurrences include private teacher reasons, so protect exported files.

### In-app note previews

`npm ci` runs `build-assets.mjs` to copy the locked PDF.js package's browser module, same-origin worker, fonts, character maps, and JavaScript image-codec fallbacks into generated public assets. Keep that build helper and the dependency lockfile in deployment source; generated assets are recreated during installation rather than included in the source archive.

The release generated 194 PDF.js assets, totaling approximately 4.21 MB. The deployed main and worker modules returned HTTP 200 with JavaScript content types. The actual shared 106073-byte PDF rendered in both local and live browser checks, including its selectable page text.

The app fetches preview bytes through its same-origin `/api/notes/:id/preview` endpoint and renders PDF pages on canvas, supported images through bounded blob URLs, and text/Markdown as plain text. It does not use an iframe, browser PDF plugin, or Google/Microsoft document viewer. The application CSP permits same-origin workers and blob images while retaining blocked frames/plugins. Office formats remain downloadable. Preview limits include the existing 20 MiB attachment bound and a 1 MiB text excerpt; the original file remains available to download.

## Uploads and persistence

Approved members obtain a signed URL for one random staging object, upload directly to Supabase, and submit the ticket with the note. The server moves the object to its final private path before reading and validating its contents. The browser cannot overwrite the published object through the staging URL. Canceled and completed tickets remain reserved until their upload token has expired, then stale files are cleaned on subsequent upload requests. Reservations use a full 20 MiB each and count toward the app’s 700 MiB attachment cap. A canceled upload can temporarily reserve capacity.

Downloads use short-lived signed attachment links. The database contains sessions, account lockouts, API rate counters, and upload reservations so restarting or scaling functions does not reset them. Large library and backup JSON responses are streamed. Disk is never used for cloud persistence.

## Verification and backup

Run `npm test` locally, verify the database with the restricted runtime account, and test approved-member posting, file download, cancellation, revoked access, and persistence on the deployed URL. The admin backup includes users/password hashes and text; keep it private. Also back up the private Storage bucket. Portable class exports omit transient email tokens, outbox messages, and notification preferences; retain a separate secure database backup if subscriptions must be restored. Free hosting has no automatic recovery guarantee.

The current source passed **147 tests**, including assisted-recovery enumeration/throttling, verification/reauthentication, stale session/hash and replay checks, temporary expiry/forced-change and approval boundaries, portable password markers, and support/semester/push UI regressions. Publication identifiers remain `dpl_7p1QeXUcWzEbPCWgur74LRV1tBws` / `114bc5075103a10392335b7d563e4a8e02e19ad3d9141fbb3f9bec72e8c15ba4` until deployment is verified. The preceding 131-test production source/access/data-preservation/worker checks belong to that historical release. Previous checks below exercised their respective access policies and do not establish phone delivery.

### Earlier verification

All 45 isolated tests passed for the 6 November 2026 semester update, including cross-semester discussion denial, reassignment, the then-public note access, legacy SQLite preservation, and older portable backups. Their release evidence is in [DEPLOYMENT.md](DEPLOYMENT.md). The current source instead requires signed-in semester-scoped class access.

The earlier routine/preview suite passed 48/48 and the earlier teacher/student release passed 65/65. Local browser checks then exercised approval, weekly assignments, daily publication, teacher replies, note editing, student alerts, and notification context. Its local worker created one reminder while actual mail was disabled. The then-production checks included public content/teaching reads and anonymous private-write denial; those readings describe that historical policy, not the new guest gateway. No production test timetable or teacher account was created for those checks.

## Email delivery

Brevo Free supplies SMTP delivery with a 300-email daily allowance. The app limits SMTP attempts to 280 per UTC day and notification attempts to 180, including failed or uncertain sends. Messages go to individual recipients; notifications require approval, verified email, the matching semester, and explicit category opt-in. Preferences are under **Account → Email preferences**; recovery is under **Sign in → Forgot password?**.

Token-bearing mail is encrypted in the durable outbox. Delivery starts after database commit. The active Supabase `pg_cron` job `classnest-email-delivery` now uses `pg_net` every minute (`* * * * *`) at https://pusoe.vercel.app/api/internal/email-delivery. `schema/teaching-worker-postgres.sql` updates the existing schedule after the teacher-aware worker is deployed. It retains the separate bearer secret referenced from Supabase Vault. New automatic-run evidence is recorded in [DEPLOYMENT.md](DEPLOYMENT.md); the previously verified five-minute requests and automatic run belong to earlier releases. No raw SMTP or worker secret belongs in source, browser code, or a cron command.

The email release is deployed and enabled. Production QA confirmed real reset and notification messages in Gmail's inbox; verification mail reached Spam, so students should check there too. All temporary QA records were removed without changing existing passwords or sessions. See [EMAIL-SETUP.md](EMAIL-SETUP.md) for environment variables and [DEPLOYMENT.md](DEPLOYMENT.md) for release details.

Official documentation: [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Supabase pricing](https://supabase.com/pricing), [Postgres connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [Vercel limits](https://vercel.com/docs/functions/limitations), [Brevo Free](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans).
