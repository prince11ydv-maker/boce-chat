-- Apply as project owner before publishing the manual support workflow.
SELECT pg_advisory_xact_lock(73481397);
CREATE TABLE IF NOT EXISTS public.password_support_requests(id text PRIMARY KEY,user_id text REFERENCES public.users(id) ON DELETE SET NULL,email text NOT NULL CHECK(length(email)<=200),identity_hash text NOT NULL,message text NOT NULL CHECK(length(message)<=500),status text NOT NULL CHECK(status IN('pending','verified','resolved','rejected')),created bigint NOT NULL,expires bigint NOT NULL,verified_by text REFERENCES public.users(id) ON DELETE SET NULL,verified_at bigint,verification_note text CHECK(length(verification_note)<=1000),password_stamp text,resolved_at bigint);
CREATE INDEX IF NOT EXISTS password_support_identity ON public.password_support_requests(identity_hash,created);
CREATE INDEX IF NOT EXISTS password_support_status ON public.password_support_requests(status,created);
CREATE INDEX IF NOT EXISTS password_support_expiry ON public.password_support_requests(expires);
ALTER TABLE public.password_support_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.password_support_requests FROM anon,authenticated,PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.password_support_requests TO classnest_app;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='password_support_requests' AND policyname='classnest_server') THEN
    CREATE POLICY classnest_server ON public.password_support_requests FOR ALL TO classnest_app USING(true) WITH CHECK(true);
  END IF;
END $$;
