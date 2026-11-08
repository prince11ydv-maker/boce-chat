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

The current mobile/student semester-lock production deployment is `dpl_9ohMbPv9WxytCDTHMTv2zNNtL1Pe`, READY with source SHA-256 `f79380302ac75c22888aba88f92692aaa4055a3cf6a25a83b6da889466fa2c4e` across 54 web deployment files. Its 108 website tests, Android build/signature checks, production source/content checks, and successful automatic worker run are recorded in [DEPLOYMENT.md](DEPLOYMENT.md). The earlier address, `classnest-pu.vercel.app`, redirects to the primary website. Earlier notice/dashboard identifiers and test totals remain historical evidence in that deployment guide.

Mobile installation is documented separately in [MOBILE.md](MOBILE.md). The Android/iPhone home-screen app and signed Android APK use the same site/backend; the new web source inventory contains 54 files. No database migration, re-import, extra cloud resource, paid plan, or store account is needed. Native Android signing material stays privately under the owner's user profile and is excluded from source/Git archives. The release APK is a separate public artifact, not a server credential.

Adding this source to GitHub does not connect the existing Vercel project to Git or turn on automatic deployments. It requires no new service, paid plan, credential, or deployment. The current website continues to use its existing provider settings.

## Run or deploy the source

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

Keep the encryption and worker secrets stable across deployments. [EMAIL-SETUP.md](EMAIL-SETUP.md) explains sender verification, consent, queue budgets, and the authenticated worker. Changing a domain requires coordinated origin, redirect, and queued-email handling as described there.

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

Create the private attachment bucket and initialize or import the intended workspace only through the documented setup procedure. Imports refuse occupied targets. After the worker route is live and its secret is stored in Supabase Vault, follow [EMAIL-SETUP.md](EMAIL-SETUP.md) for `schema/email-worker-postgres.sql` and `schema/teaching-worker-postgres.sql`. They configure one existing delivery job, not a second scheduler. Never run the initial schema or an import over the current production database.

The files in [AZURE-HOSTING.md](AZURE-HOSTING.md) and `scripts/azure/` are retained legacy hosting material. The live website runs on Vercel and Supabase; the newer teaching and notice workflows are documented and verified for SQLite/PostgreSQL.
