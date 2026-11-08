-- Apply as project owner before notice-attachment-aware application code.
SELECT pg_advisory_xact_lock(73481397);
CREATE TABLE IF NOT EXISTS public.notice_attachments(notice_id text PRIMARY KEY REFERENCES public.notices(id) ON DELETE CASCADE,filename text NOT NULL UNIQUE,original_name text NOT NULL,mime text NOT NULL,size bigint NOT NULL CHECK(size>0 AND size<=20971520));
ALTER TABLE public.notice_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notice_attachments FROM anon,authenticated,PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.notice_attachments TO classnest_app;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notice_attachments' AND policyname='classnest_server') THEN
    CREATE POLICY classnest_server ON public.notice_attachments FOR ALL TO classnest_app USING(true) WITH CHECK(true);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.notice_uploads(ticket_id text PRIMARY KEY REFERENCES public.upload_tickets(id) ON DELETE CASCADE,filename text NOT NULL UNIQUE,expires bigint NOT NULL);
ALTER TABLE public.notice_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notice_uploads FROM anon,authenticated,PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.notice_uploads TO classnest_app;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='notice_uploads' AND policyname='classnest_server') THEN
    CREATE POLICY classnest_server ON public.notice_uploads FOR ALL TO classnest_app USING(true) WITH CHECK(true);
  END IF;
END $$;
ALTER TABLE public.app_notifications DROP CONSTRAINT IF EXISTS app_notifications_type_check;
ALTER TABLE public.app_notifications ADD CONSTRAINT app_notifications_type_check CHECK(type IN('note','notice','daily-routine','teacher-reminder','class-reminder','class-status'));
