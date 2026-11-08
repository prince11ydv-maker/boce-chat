-- Apply as project owner before deploying student class reminders.
SELECT pg_advisory_xact_lock(73481397);
ALTER TABLE public.app_notifications DROP CONSTRAINT IF EXISTS app_notifications_type_check;
ALTER TABLE public.app_notifications ADD CONSTRAINT app_notifications_type_check
  CHECK(type IN('note','notice','daily-routine','teacher-reminder','class-reminder','class-status'));
