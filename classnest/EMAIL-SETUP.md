# Classnest email

Password recovery, mailbox verification, and opt-in class notifications use Brevo SMTP at https://pusoe.vercel.app. The deployment and redirect from https://classnest-pu.vercel.app are verified; old email-link fragments reach the new site's matching dialog. Existing accounts and passwords remain unchanged; users sign in once at the new hostname. Brevo Free allows 300 emails per day; no paid upgrade is configured. See [DEPLOYMENT.md](DEPLOYMENT.md) for the current verified deployment and source hash.

## Notice attachments and direct notice links · 8 November 2026

The notice attachment/direct-alert update is READY in production. An administrator's published notice creates private account notifications in the same transaction as the notice and attachment metadata. The author is excluded. Approved students receive their current semester's notices; teacher scope comes from the primary semester or actual assignments, never profile choices alone. Body-empty notices with an attachment still produce a titled alert. Opening the update focuses the specific notice, with semester context preserved, through `#notices/ID`.

Email copies use the existing **Notices** preference, not Events. They require a verified address, current approval/scope, and explicit notice consent. The server reads the actual notice title/body/author, deduplicates the account alert, and uses one encrypted class-notification enqueue path; the old parallel notice-email enqueue is removed. Before SMTP, delivery checks consent, account/semester/assignment access, and the notice's continued existence. Deleted or moved notices and revoked permissions suppress stale queued mail. The email button reads **Read this notice** and remains on the configured website origin. Attachment files are viewed/downloaded from Classnest rather than sent as email attachments.

No subscription is enabled automatically, and no new sender, SMTP key, paid provider, or delivery job is required. Notice email consumes the existing notification queue and daily budget. Account alerts do not require email consent and appear with normal open-site polling; no operating-system push channel is added. All 88 automated tests passed, including fake-transport notice consent, scope, stale-message suppression, and rollback checks. The notice migration is applied with RLS, server-only CRUD policies, zero public grants, and no Supabase security-advisor findings. Local photo/PDF publication and rendering checks passed. The student notification list showed notice alerts, and **Open update** opened the exact notice card in its semester. Production source/content/access checks passed and the automatic worker returned HTTP 200 with no error at 2026-11-08 01:27 UTC (07:12 Nepal time), including the new cleanup queries with no reminder due. No real production notice email or production test notice publication is claimed. Release identifiers and the local authenticated-flow verification boundary are recorded in [DEPLOYMENT.md](DEPLOYMENT.md).

## Teacher profile semester choices · 8 November 2026

The teacher dashboard update is READY in production with all 71 automated tests passing and private teacher workflows verified locally. The live teacher signup supports checking multiple semesters; verification did not submit that form or create a production account. Selecting teaching semesters is a profile/display choice and does not create a class assignment or an email subscription. Reminder email continues to depend on an actual assigned occurrence, current teacher approval, verified address, and the separate teacherReminders opt-in. A real assigned class remains eligible even when its semester is not checked in the teacher profile. General note/daily/attendance email retains its existing category and semester consent. The All my semesters filter does not subscribe the teacher to every semester. No new SMTP key, sender, delivery job, or paid email service was introduced, and live public state still reports email enabled. A real teacher account now exists in production and is preserved; this update does not claim a new teacher-reminder email has reached that person's inbox.

## Teacher and daily-plan update · 7 November 2026

The teacher/student release is READY with all 65 automated tests passing. It adds account alerts for notes, daily plans, teacher reminders, and attendance replies. Account alerts refresh about every 60 seconds while Classnest is open; this is not operating-system push delivery. Email remains an additional verified, opt-in channel. The new teacher/daily email flows are covered by fake-transport tests and local worker checks; the real-inbox evidence under Earlier verification below belongs to the older email release.

Approved students receive class email only for their assigned account semester, including notes from approved teachers/admins. Changing the public semester selector or a stale preference does not expand eligibility. The Events preference covers daily timetable and teacher-attendance updates. Approved teachers separately enable **My teaching reminders · 3 minutes before class** (`teacherReminders`) in Account → Email preferences. All email categories start off. Address verification, current approval, consent, assignment, and applicable semester are rechecked before queued delivery.

Administrators must approve genuine teacher requests and assign each teacher to a subject, weekday, 24-hour Nepal start/end time, and optional room. There were no approved production teachers at release time. The imported weekly PDF grid does not identify teacher account IDs; no account, address, or mapping has been invented. A published daily plan replaces weekly assignments for that date, including an empty day without classes.

The reminder target is three minutes before class. The active one-minute worker scans durable class occurrences and suppresses duplicate reminders; scheduling, the app's notification budget, retries, and SMTP/provider delay can change actual arrival time. Its automatic run at 2026-11-07 19:16 UTC (8 November, 01:01 Nepal time) returned HTTP 200 with `{"accepted":0,"checked":3,"reminders":{"reminded":0,"checked":0}}`. No class reminder was due in that run, and there were no real approved production teachers at verification. Teachers reply Coming with 1–5, 5–10, or 10+ minutes, or Not coming with a required reason. Reasons remain in authorized teacher/admin views and private class notifications; the public daily board redacts them. Email links retain the relevant semester/date. No new sender credentials or paid service are required by this update.

## Server configuration

Set these only in Vercel's production environment:

- EMAIL_ENABLED=true, after the sender and SMTP delivery are verified.
- PUBLIC_ORIGIN=https://pusoe.vercel.app
- ALLOWED_HOSTS=classnest-pu.vercel.app,pusoe.vercel.app
- MAIL_HOST=smtp-relay.brevo.com
- MAIL_PORT=587 (mandatory STARTTLS) or 465 (TLS).
- MAIL_USER: the Brevo SMTP login, not the Brevo account email.
- MAIL_PASSWORD: a dedicated SMTP key. Store as a Secret.
- MAIL_FROM: the sender address verified in Brevo.
- MAIL_FROM_NAME=Classnest
- EMAIL_ENCRYPTION_KEY: an independent random 32-byte hex Secret.
- EMAIL_CRON_SECRET: another independent random 32-byte hex Secret.

Do not place keys in frontend code, source archives, logs, or chat. Never disable TLS certificate verification. Brevo may replace unauthenticated sender domains with its delivery domain; an owned domain is recommended for long-term sender branding. Provider SMTP acceptance is distinct from delivery to an inbox.

## Database and retry worker

The production project has schema/email-postgres.sql applied. For a new deployment, apply it once to the existing project. It adds private RLS-protected tables without changing existing users or their password hashes. SQLite initializes its corresponding tables automatically from schema/email-sqlite.sql.

The server inserts encrypted outbox messages in the same transaction as their reset/verification tokens or class content. Delivery happens after commit. Vercel waitUntil starts prompt processing. Production has pg_cron and pg_net configured with the active classnest-email-delivery job on `* * * * *`. The job references the worker bearer secret in Supabase Vault under classnest-email-worker-secret. For a new deployment, create that Vault secret and apply schema/email-worker-postgres.sql after the live worker route is deployed. For the teacher workflow, also apply `schema/teacher-accounts-postgres.sql` and `schema/teaching-postgres.sql`, then `schema/teaching-worker-postgres.sql` after the teacher-aware route is live. The last migration updates the existing job to run every minute; it does not introduce a second delivery job or expose a secret.

The worker requires the bearer secret, X-Classnest-Request:1, JSON content type, and an empty JSON object. Its schedule stores only the Vault lookup, never the raw secret. No public SECURITY DEFINER application function is installed. Background leases recover interrupted attempts. SMTP retries provide at-least-once delivery, so a lost acknowledgement can produce a duplicate despite a stable Message-ID.

For hostname changes, confirm the outbox is empty before activating a new PUBLIC_ORIGIN: already queued messages contain absolute URLs checked against that origin. Keep the encryption and worker secrets unchanged. The earlier classnest_email_worker_domain migration retained job 1 on its then-five-minute schedule at https://pusoe.vercel.app/api/internal/email-delivery. Its authenticated pg_net request returned 200 with {"accepted":0,"checked":3}, no timeout, and no error. The teacher release now retains that target/secret and changes job 1 to every minute. New automatic-run evidence is recorded in [DEPLOYMENT.md](DEPLOYMENT.md). The old address preserves paths, queries, and fragments through its verified 308 redirect, including reset, verification, and unsubscribe dialogs.

App limits reserve recovery capacity: at most 280 SMTP attempts per UTC day, including failed/uncertain attempts, with at most 180 notification attempts. Notifications use at most 800 of the 1000 outbox slots. Provider limits can impose additional restrictions. Failed token-bearing payloads are cleared; expired rows are pruned.

## Student use

**Sign in → Forgot password?** requests a generic response for existing and unknown addresses. A reset link expires after 30 minutes, can be used once, and revokes old sessions when completed. A normal password change also invalidates pending reset links. Opening a link does not reset a password; the student chooses and submits a new password.

**Account → Email preferences** lets students verify their address and choose new notes, announcements, or schedule/daily/attendance updates. Student email follows the assigned account semester. Teachers can separately opt in to their own assigned-class reminders. Check Spam as well as the inbox for verification mail. All categories default off. Verification does not grant posting access. Only approved accounts with verified email and an enabled category receive the applicable updates, and these conditions are rechecked before queued delivery. Every update contains a link to stop notification emails without signing in.

Cloud portable class backups omit transient reset/verification tokens, outbox content, and email preferences. Retain a separate secure database backup if subscriptions must be restored; otherwise students can opt in again. SQLite snapshots contain the complete database, with outbox payloads encrypted using the separate server key.

## Earlier verification

All 45 automated tests passed for the semester update, including the existing reset-token secrecy/expiry/replay, password/session changes, verification and consent, notification recipient filtering, encryption/tampering, quotas, leases/retries, and isolated HTTP email flows. Email subscription semester choices do not change private-discussion membership; only administrators can update the account's assigned semester. The hostname update separately verified new-origin API access and rejection of cross-site mutations, the old email-link redirect, and the authenticated worker response described above.

Separate production checks confirmed the verified Brevo sender and real SMTP delivery. Reset and class-notification emails reached Gmail's inbox; verification mail reached Spam. The canonical state endpoint returned 200 with emailAvailable true, and the browser recovery form was verified. Reset requests for known and unknown addresses returned generic 202 responses. A temporary QA verification token succeeded once (200), failed on replay (400), and left the QA preferences verified.

During the earlier email release at the previous hostname, an authenticated request through pg_net returned 200 with {"accepted":0,"checked":3}; an unauthenticated request returned 401. Its automatic cron run at 2026-11-06 01:10:00 UTC succeeded with the same HTTP 200 response, no timeout, and no error. The new-hostname manual authenticated request is verified separately above; no automatic new-hostname run is claimed here. The Supabase security advisor reported no findings after the email tables and pg_net/pg_cron were applied. Temporary QA user/session/notice records were removed; original accounts and passwords remain. Fake-transport tests alone do not establish inbox delivery.

Official references: [Brevo free plan](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans), [sender verification](https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email), [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions), [OWASP password recovery](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
