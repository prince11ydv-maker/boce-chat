-- Apply as project owner before deploying teaching-aware server code.
SELECT pg_advisory_xact_lock(73481397);
CREATE TABLE IF NOT EXISTS public.teacher_slots(id text PRIMARY KEY,semester integer NOT NULL REFERENCES public.semesters(id),teacher_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,subject_id text NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,weekday integer NOT NULL CHECK(weekday BETWEEN 1 AND 7),start_minute integer NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),end_minute integer NOT NULL CHECK(end_minute BETWEEN 1 AND 1440 AND end_minute>start_minute),room text NOT NULL DEFAULT '',revision integer NOT NULL CHECK(revision>0),active integer NOT NULL DEFAULT 1 CHECK(active IN(0,1)),updated bigint NOT NULL);
CREATE TABLE IF NOT EXISTS public.daily_routines(semester integer NOT NULL REFERENCES public.semesters(id),class_date text NOT NULL,title text NOT NULL,rows_json text NOT NULL,revision integer NOT NULL CHECK(revision>0),updated bigint NOT NULL,PRIMARY KEY(semester,class_date));
CREATE TABLE IF NOT EXISTS public.class_occurrences(id text PRIMARY KEY,source_key text NOT NULL UNIQUE,source_type text NOT NULL CHECK(source_type IN('weekly','daily')),source_id text NOT NULL,source_revision integer NOT NULL,semester integer NOT NULL REFERENCES public.semesters(id),class_date text NOT NULL,teacher_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,subject_id text NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,start_minute integer NOT NULL,end_minute integer NOT NULL,starts_at bigint NOT NULL,ends_at bigint NOT NULL,room text NOT NULL DEFAULT '',active integer NOT NULL DEFAULT 1 CHECK(active IN(0,1)),response text NOT NULL DEFAULT 'pending' CHECK(response IN('pending','coming','absent')),eta text NOT NULL DEFAULT '' CHECK(eta IN('','1-5','5-10','10+')),reason text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated bigint NOT NULL);
CREATE TABLE IF NOT EXISTS public.app_notifications(id text PRIMARY KEY,user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,type text NOT NULL CHECK(type IN('note','notice','daily-routine','teacher-reminder','class-reminder','class-status')),semester integer NOT NULL REFERENCES public.semesters(id),title text NOT NULL,body text NOT NULL,url text NOT NULL,reference text NOT NULL,expires_at bigint NOT NULL,created bigint NOT NULL,read_at bigint);
CREATE INDEX IF NOT EXISTS teacher_slots_scope ON public.teacher_slots(semester,active,weekday);
CREATE INDEX IF NOT EXISTS teacher_slots_teacher ON public.teacher_slots(teacher_id,active);
CREATE INDEX IF NOT EXISTS daily_routines_date ON public.daily_routines(class_date);
CREATE INDEX IF NOT EXISTS occurrences_scope ON public.class_occurrences(semester,class_date,active);
CREATE INDEX IF NOT EXISTS occurrences_teacher ON public.class_occurrences(teacher_id,active,starts_at);
CREATE INDEX IF NOT EXISTS occurrences_due ON public.class_occurrences(active,response,starts_at);
CREATE INDEX IF NOT EXISTS occurrences_source ON public.class_occurrences(source_type,source_id,starts_at);
CREATE INDEX IF NOT EXISTS notifications_user ON public.app_notifications(user_id,created);
CREATE INDEX IF NOT EXISTS notifications_reference ON public.app_notifications(user_id,type,reference);
CREATE INDEX IF NOT EXISTS notifications_expiry ON public.app_notifications(expires_at);
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['teacher_slots','daily_routines','class_occurrences','app_notifications'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, PUBLIC',tbl);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO classnest_app',tbl);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=tbl AND policyname='classnest_server') THEN
      EXECUTE format('CREATE POLICY classnest_server ON public.%I FOR ALL TO classnest_app USING (true) WITH CHECK (true)',tbl);
    END IF;
  END LOOP;
END $$;
