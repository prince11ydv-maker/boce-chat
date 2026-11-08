-- Apply as the project owner before deploying push-aware code.
SELECT pg_advisory_xact_lock(73481397);
CREATE TABLE IF NOT EXISTS public.push_devices(id text PRIMARY KEY,user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,session_token text NOT NULL REFERENCES public.sessions(token) ON DELETE CASCADE,kind text NOT NULL CHECK(kind IN('web','android')),endpoint_hash text NOT NULL UNIQUE,payload text NOT NULL,label text NOT NULL CHECK(length(label)<=60),created bigint NOT NULL,updated bigint NOT NULL);
CREATE INDEX IF NOT EXISTS push_devices_owner ON public.push_devices(user_id,session_token);
CREATE TABLE IF NOT EXISTS public.push_queue(id text PRIMARY KEY,device_id text NOT NULL REFERENCES public.push_devices(id) ON DELETE CASCADE,notification_id text NOT NULL REFERENCES public.app_notifications(id) ON DELETE CASCADE,state text NOT NULL CHECK(state IN('pending','sending','sent','failed')),attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),next_attempt bigint NOT NULL,lease text,lease_until bigint,expires_at bigint NOT NULL,created bigint NOT NULL,last_code text);
CREATE INDEX IF NOT EXISTS push_queue_due ON public.push_queue(state,next_attempt,lease_until);
CREATE INDEX IF NOT EXISTS push_queue_expiry ON public.push_queue(expires_at);
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['push_devices','push_queue'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, PUBLIC',tbl);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO classnest_app',tbl);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=tbl AND policyname='classnest_server') THEN
      EXECUTE format('CREATE POLICY classnest_server ON public.%I FOR ALL TO classnest_app USING (true) WITH CHECK (true)',tbl);
    END IF;
  END LOOP;
END $$;
