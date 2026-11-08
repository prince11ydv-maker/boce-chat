-- Additive rollout: deploy explicit user INSERT columns and qualify joined
-- notice/thread semester filters before applying this migration.
-- Keep the field nullable while an older application may still create users.
-- Re-run this backfill after the semester-aware release to catch that interval.
SELECT pg_advisory_xact_lock(73481397);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS semester integer REFERENCES public.semesters(id);
UPDATE public.users SET semester=COALESCE(
  (SELECT s.id FROM public.settings w JOIN public.semesters s ON s.id=w.semester WHERE w.id=1),
  (SELECT min(id) FROM public.semesters)
) WHERE semester IS NULL;
CREATE INDEX IF NOT EXISTS users_semester ON public.users(semester);
