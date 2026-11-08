# Classnest on Vercel Hobby and Supabase Free

The Express app runs on Vercel in Mumbai. Supabase in Mumbai stores the PostgreSQL database and private attachments. Local development still uses SQLite and `data/uploads`.

The mobile and student semester-lock release is READY in production. It passed 108 website tests, 57 Android URL-policy checks, Android release build/lint, APK signature/alignment checks, and production source/content checks. Existing accounts and the public class content were preserved; the automatic worker returned 200 after deployment. The free Android/iPhone home-screen app reuses the site and existing accounts/backend; the separately signed Android APK uses the same HTTPS service. No schema migration, service, paid plan, or store publishing account was required. See [MOBILE.md](MOBILE.md) for the APK and installation, and [DEPLOYMENT.md](DEPLOYMENT.md) for identifiers and verification boundaries.

The worker caches only fixed public offline-screen/icon assets, not class/account content, files, or API responses. Internet is needed for notes, chat, timetables, and account actions. Existing in-app/email notifications continue; no operating-system push or background polling guarantee is added. Signed-in students stay in their assigned semester on both clients; approved teachers/admins retain their controls. Anonymous public reading remains available, so the account lock does not turn published notes into private material.

The earlier 8 November teacher dashboard and multiple-semester profile release reached READY on the existing free hosting. All 71 automated tests and local browser workflows passed. Its production frontend files matched the tested source, live signup permitted multiple teacher-semester selections, and anonymous private-route requests were rejected. Public state stayed available, the original weekly routine was preserved, and the exam section stayed empty. The real teacher account was preserved. The existing worker job remains active every minute. Release identifiers and the local/private-dashboard verification boundary are recorded in [DEPLOYMENT.md](DEPLOYMENT.md).

The later notice attachment and direct-alert update is READY in production with all 88 automated tests passing. Its cloud migration/security checks, local photo/PDF publication/rendering and student alert links, and production source/content/access checks passed. The automatic worker returned 200 with the new cleanup queries, and public class content was preserved. Authenticated posting and alert navigation were tested locally; production verification introduced no QA post or notice email. It reuses the existing private bucket, 700 MiB shared note/notice allowance, SMTP sender, and worker; no additional hosting resource, credential, or paid service is required.

Profile semester choices do not grant account approval, class assignments, private-notification scope, or discussion access. No additional hosting provider, paid plan, credential, or notification service was introduced.

The earlier semester update preserved existing accounts, sessions, and class content. Its separate live semester-access checks remain documented in [DEPLOYMENT.md](DEPLOYMENT.md).

The primary address is **https://pusoe.vercel.app**. The previous address, https://classnest-pu.vercel.app, redirects with paths, queries, and email-link fragments preserved. The deployment and redirect were verified. Users sign in once at the new hostname with their existing password. Browser-local saved notes and appearance choices do not automatically transfer between hostnames.

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

Registration requires a valid account semester. Notes remain public in all semesters. Discussion state, reply reads, creation, replies, and deletion require an approved member's recorded semester; administrators can moderate every semester. Assignment changes and sensitive discussion reads/writes share the transaction lock, so stale cookies or a forged browsing-semester value do not grant access. Only administrators change account-semester assignments. Email preferences never change membership; student email eligibility also checks the current assigned semester.

### Teacher accounts and daily timetables

Existing PostgreSQL installations need the additive owner-run `schema/teacher-accounts-postgres.sql` and `schema/teaching-postgres.sql` migrations. They are applied in production as `classnest_teacher_accounts` and `classnest_teaching_workflows`. The first adds the requested account type, approved teacher role, and teacher reminder preference. The second adds teacher_slots, daily_routines, class_occurrences, and app_notifications, with RLS, server-only CRUD policies, and no browser Data API grants. The post-migration security advisor returned no findings. The original two users, one subject, and one routine were preserved. SQLite initializes its matching schema locally. New teacher/daily migrations are supplied for SQLite/PostgreSQL; the retained legacy Azure adapter is not a verified implementation of these new workflows.

Teacher signup remains pending until an administrator approves the account. Approve real teachers in Manage workspace, then assign teacher, subject, weekday, 24-hour Nepal start/end time, and room in Teaching & my notes. No approved production teachers existed during the 7 November release verification; a real teacher joined during the 8 November dashboard update and was preserved. The imported PDF grid does not identify account IDs; no teacher identities, emails, or mappings are generated from it.

Daily plans appear before the weekly routine. Admins choose a date, enter structured classes or prefill that weekday's assignments, and publish. A daily plan overrides weekly teacher assignments for that date; publishing an empty plan means no classes. The date view spans seven days in the past through thirty days ahead, with 35-day daily/occurrence retention. Existing weekly/exam editors and HTML-table imports stay available. Note authors can edit their title, subject, and content through My notes, with existing attachments retained; administrators can edit any note.

Account alerts cover notes, daily changes, and teacher responses for approved recipients. Students receive their current semester's updates; teachers receive relevant assignments and their own reminders. The existing email worker now checks due classes every minute, targeting a teacher reminder three minutes before class. Teacher emails separately require verified address and teacherReminders opt-in; normal class emails retain category consent. Actual arrival can lag behind the target because of polling, transport, or provider delay. Browser account alerts refresh about every 60 seconds while open, and no operating-system push channel is configured.

The public daily board shows Pending/Coming/Not coming and arrival bands; absence explanations remain private to authorized teacher/admin views and class notifications. Teachers choose 1–5, 5–10, or 10+ minutes when coming, or give a reason when absent. The homepage clock and date explicitly use Asia/Kathmandu.

### Teacher overview and multiple semesters

For this update, existing PostgreSQL projects need the additive owner-run `schema/teacher-semesters-postgres.sql` migration before the new server is deployed. It creates the `teacher_semesters` profile table with RLS, server-only CRUD policy, and no public Data API grants. It is applied in production as `classnest_teacher_semesters`; checks returned RLS enabled, zero public grants, and no security-advisor findings. SQLite initializes `schema/teacher-semesters-sqlite.sql` automatically. The production deployment is READY; anonymous dashboard and profile mutation requests were rejected, and existing public content was preserved.

Approved teachers get an overview of their own classes, unanswered replies, next 48 hours, weekly assignments, and notes. The class filter combines chosen semesters with real administrator assignments; choosing fewer semesters cannot hide an assigned class. Profile choices are separate from primary class membership and cannot authorize discussions, private absence reasons, notifications, or class assignments. Teacher notes are filtered by authorship, and the selected-semester note view bounds text separately. No new hosting resource, credential, worker, or paid upgrade is required.

Portable exports add `teacher_semesters` as the fourteenth durable table. Older exports without it remain accepted and start with no saved teacher choices; the dashboard then falls back to the account's primary semester. As before, import only into an empty target and preserve current accounts/content rather than re-importing over production.

### Notice attachments and direct alerts

For an existing installation, apply `schema/notice-attachments-postgres.sql` as the project owner before deploying the notice-aware code. It is applied in production as `classnest_notice_attachments`. It adds `notice_attachments` for durable one-file-per-notice metadata, `notice_uploads` for transient upload-purpose binding, and the notice app-notification type. Both new tables have RLS enabled, server-only CRUD policies, and zero grants to anon, authenticated, or PUBLIC. The Supabase security advisor returned no findings. Production retained three accounts, one approved teacher, one subject, no notes or notices, and one routine. SQLite initializes `schema/notice-attachments-sqlite.sql` locally. The new deployment is READY; production application checks and release identifiers are recorded in [DEPLOYMENT.md](DEPLOYMENT.md).

Notice PDFs/photos are limited to 20 MiB each and share the same 700 MiB app attachment allowance with notes. Header/dimension validation uses pinned `image-size` 2.1.0. Allowed originals include PDF, JPG/JPEG, PNG, WebP, GIF, BMP, AVIF, HEIC/HEIF, and TIF/TIFF, with image bounds of 100 megapixels and 30,000 pixels per side. Browser-native previews use tighter 16-megapixel/12,000-pixel-per-side limits. HEIC/HEIF/TIFF and larger originals stay downloadable; PDFs use the existing bounded self-hosted viewer. Header checks do not establish full decoding or antivirus safety.

The private bucket and core nine-column upload ticket are reused. A purpose marker prevents note/notice ticket substitution. Completed notice tickets hold the core expiry past the legacy note-only sweeper, while markers retain their original expiry; new cleanup runs inside the shared write transaction and preserves any file referenced by either content type. The worker therefore reclaims staged/orphan data without letting an older cleanup path delete a published notice attachment. No storage credentials, SMTP key, delivery job, or provider change is required.

Notice publication creates scoped private account alerts, excluding the sender, with a direct `#notices/ID` link and semester context. Email copies use the verified, opted-in Notices category. The separate legacy notice-email enqueue is removed. Queued email rechecks current permission, consent, scope, and the notice's continued existence. Testing does not post a production notice or send a real production notice email.

### Class and exam routines

Apply owner-run `schema/routines-postgres.sql` before deploying the routine-aware server. It adds the semester/kind-keyed `routines` table with RLS, no public/anon/authenticated grants, and CRUD access only for `classnest_app`. The production `classnest_routine_tables` migration is applied; checks found zero public grants and no security-advisor findings. The server performs no PostgreSQL schema DDL. Existing SQLite databases create the corresponding table automatically; the retained Azure SQL path has its separate routine migration.

The homepage publicly shows the selected semester's weekly class routine and exam routine. Only administrators publish changes, from the homepage or Manage workspace. Tables allow 12 columns, 40 rows, 160-character cells, 80-character titles/headings, and 100 KiB serialized content. Revision checks reject stale saves rather than overwriting a newer table. Exam routines start empty and remain empty until published. Resetting a routine retains its increasing revision, preventing stale tabs from recreating an earlier revision unnoticed.

Current portable-v1 backups have fifteen durable tables, adding notice attachment metadata to routines, teaching collections, and teacher semester-profile choices. Older nine-, ten-, thirteen-, and fourteen-table exports remain supported and gain empty missing collections; account types normalize to student unless an existing teacher role identifies the account. App-notification inboxes, sessions, notice upload markers, email tokens, email preferences, outbox content, and secrets are omitted. File bytes must be backed up separately from metadata. Imports validate structure, references, dates, revisions, duplicate keys, and note/notice filename aliases, and refuse occupied targets. Class occurrences include private teacher reasons, so protect exported files.

### In-app note previews

`npm ci` runs `build-assets.mjs` to copy the locked PDF.js package's browser module, same-origin worker, fonts, character maps, and JavaScript image-codec fallbacks into generated public assets. Keep that build helper and the dependency lockfile in deployment source; generated assets are recreated during installation rather than included in the source archive.

The release generated 194 PDF.js assets, totaling approximately 4.21 MB. The deployed main and worker modules returned HTTP 200 with JavaScript content types. The actual shared 106073-byte PDF rendered in both local and live browser checks, including its selectable page text.

The app fetches preview bytes through its same-origin `/api/notes/:id/preview` endpoint and renders PDF pages on canvas, supported images through bounded blob URLs, and text/Markdown as plain text. It does not use an iframe, browser PDF plugin, or Google/Microsoft document viewer. The application CSP permits same-origin workers and blob images while retaining blocked frames/plugins. Office formats remain downloadable. Preview limits include the existing 20 MiB attachment bound and a 1 MiB text excerpt; the original file remains available to download.

## Uploads and persistence

Approved members obtain a signed URL for one random staging object, upload directly to Supabase, and submit the ticket with the note. The server moves the object to its final private path before reading and validating its contents. The browser cannot overwrite the published object through the staging URL. Canceled and completed tickets remain reserved until their upload token has expired, then stale files are cleaned on subsequent upload requests. Reservations use a full 20 MiB each and count toward the app’s 700 MiB attachment cap. A canceled upload can temporarily reserve capacity.

Downloads use short-lived signed attachment links. The database contains sessions, account lockouts, API rate counters, and upload reservations so restarting or scaling functions does not reset them. Large library and backup JSON responses are streamed. Disk is never used for cloud persistence.

## Verification and backup

Run `npm test` locally, verify the database with the restricted runtime account, and test approved-member posting, file download, cancellation, revoked access, and persistence on the deployed URL. The admin backup includes users/password hashes and text; keep it private. Also back up the private Storage bucket. Portable class exports omit transient email tokens, outbox messages, and notification preferences; retain a separate secure database backup if subscriptions must be restored. Free hosting has no automatic recovery guarantee.

All 45 isolated tests passed for the 6 November 2026 semester update, including cross-semester access denial, reassignment, public-note access, legacy SQLite preservation, and older portable backups. Production migration and deployment checks are recorded separately in [DEPLOYMENT.md](DEPLOYMENT.md). The frontend adds assigned-semester account details, administrator assignment controls, public FAQs, and a responsive copyright/contact footer.

The earlier routine/preview suite passed 48/48 with nine focused preview checks and the historical browser/mobile results described in [DEPLOYMENT.md](DEPLOYMENT.md). The teacher/student release now passes 65/65 automated tests. Local browser checks exercised approval, weekly assignment, daily publication, teacher replies, teacher note posting/editing, student alerts, and notification semester context. The local worker returned 200 and created one reminder with actual mail disabled; new mail delivery tests use fake transport. Production checks verified source equality, state 200, unchanged public class content, teaching state 200, and 403 for anonymous notifications and timetable writes. No production test timetable or teacher account was created.

## Email delivery

Brevo Free supplies SMTP delivery with a 300-email daily allowance. The app limits SMTP attempts to 280 per UTC day and notification attempts to 180, including failed or uncertain sends. Messages go to individual recipients; notifications require approval, verified email, the matching semester, and explicit category opt-in. Preferences are under **Account → Email preferences**; recovery is under **Sign in → Forgot password?**.

Token-bearing mail is encrypted in the durable outbox. Delivery starts after database commit. The active Supabase `pg_cron` job `classnest-email-delivery` now uses `pg_net` every minute (`* * * * *`) at https://pusoe.vercel.app/api/internal/email-delivery. `schema/teaching-worker-postgres.sql` updates the existing schedule after the teacher-aware worker is deployed. It retains the separate bearer secret referenced from Supabase Vault. New automatic-run evidence is recorded in [DEPLOYMENT.md](DEPLOYMENT.md); the previously verified five-minute requests and automatic run belong to earlier releases. No raw SMTP or worker secret belongs in source, browser code, or a cron command.

The email release is deployed and enabled. Production QA confirmed real reset and notification messages in Gmail's inbox; verification mail reached Spam, so students should check there too. All temporary QA records were removed without changing existing passwords or sessions. See [EMAIL-SETUP.md](EMAIL-SETUP.md) for environment variables and [DEPLOYMENT.md](DEPLOYMENT.md) for release details.

Official documentation: [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Supabase pricing](https://supabase.com/pricing), [Postgres connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [Vercel limits](https://vercel.com/docs/functions/limitations), [Brevo Free](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans).
