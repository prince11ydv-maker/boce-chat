-- Additive compatibility migration; apply before the teacher-aware release.
SELECT pg_advisory_xact_lock(73481397);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS accounttype text NOT NULL DEFAULT 'student' CHECK(accounttype IN ('student','teacher'));
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK(role IN ('admin','member','teacher','pending','blocked'));
UPDATE public.users SET accounttype='teacher' WHERE role='teacher';
ALTER TABLE public.email_preferences ADD COLUMN IF NOT EXISTS teacherreminders integer NOT NULL DEFAULT 0 CHECK(teacherreminders IN (0,1));
ALTER TABLE public.email_outbox DROP CONSTRAINT IF EXISTS email_outbox_kind_check;
ALTER TABLE public.email_outbox ADD CONSTRAINT email_outbox_kind_check CHECK(kind IN ('password-reset','email-verification','notification','class-notification'));
