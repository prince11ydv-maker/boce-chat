-- Apply as the project owner. Preferences never authorize private class data.
SELECT pg_advisory_xact_lock(73481397);
CREATE TABLE IF NOT EXISTS public.teacher_semesters(user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,semester integer NOT NULL REFERENCES public.semesters(id) ON DELETE CASCADE,updated bigint NOT NULL,PRIMARY KEY(user_id,semester));
CREATE INDEX IF NOT EXISTS teacher_semesters_semester ON public.teacher_semesters(semester,user_id);
ALTER TABLE public.teacher_semesters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.teacher_semesters FROM anon,authenticated,PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.teacher_semesters TO classnest_app;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='teacher_semesters' AND policyname='classnest_server') THEN
    CREATE POLICY classnest_server ON public.teacher_semesters FOR ALL TO classnest_app USING(true) WITH CHECK(true);
  END IF;
END $$;
