-- Run as the project owner before the routine-aware application release.
SELECT pg_advisory_xact_lock(73481397);
CREATE TABLE IF NOT EXISTS public.routines(
  semester integer NOT NULL REFERENCES public.semesters(id),
  kind text NOT NULL CHECK(kind IN ('class','exam')),
  content text NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  updated text NOT NULL,
  PRIMARY KEY(semester,kind)
);
ALTER TABLE public.routines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.routines FROM anon, authenticated, PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.routines TO classnest_app;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='routines' AND policyname='classnest_server') THEN
    CREATE POLICY classnest_server ON public.routines FOR ALL TO classnest_app USING (true) WITH CHECK (true);
  END IF;
END $$;
