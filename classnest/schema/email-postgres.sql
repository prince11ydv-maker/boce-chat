CREATE TABLE IF NOT EXISTS password_resets(token text PRIMARY KEY,"userId" text UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,"passwordStamp" text NOT NULL,expires bigint NOT NULL);
CREATE TABLE IF NOT EXISTS email_preferences("userId" text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,semester integer NOT NULL REFERENCES semesters(id),notes integer NOT NULL DEFAULT 0,notices integer NOT NULL DEFAULT 0,events integer NOT NULL DEFAULT 0,verified integer NOT NULL DEFAULT 0,updated bigint NOT NULL,teacherreminders integer NOT NULL DEFAULT 0 CHECK(teacherreminders IN (0,1)));
CREATE TABLE IF NOT EXISTS email_verifications(token text PRIMARY KEY,"userId" text UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires bigint NOT NULL);
CREATE TABLE IF NOT EXISTS email_outbox(id text PRIMARY KEY,"userId" text NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind text NOT NULL CHECK(kind IN ('password-reset','email-verification','notification')),payload text NOT NULL,attempts integer NOT NULL DEFAULT 0,created bigint NOT NULL,"nextAttempt" bigint NOT NULL,expires bigint NOT NULL,lease text,"leaseUntil" bigint,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','failed')),"lastCode" text);
CREATE TABLE IF NOT EXISTS email_budget(day text PRIMARY KEY,total integer NOT NULL,notifications integer NOT NULL);
CREATE INDEX IF NOT EXISTS resets_expiry ON password_resets(expires);
CREATE INDEX IF NOT EXISTS verification_expiry ON email_verifications(expires);
CREATE INDEX IF NOT EXISTS outbox_due ON email_outbox(state,"nextAttempt");
CREATE INDEX IF NOT EXISTS outbox_user ON email_outbox("userId");
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['password_resets','email_preferences','email_verifications','email_outbox','email_budget'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, PUBLIC',tbl);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO classnest_app',tbl);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=tbl AND policyname='classnest_server') THEN
      EXECUTE format('CREATE POLICY classnest_server ON public.%I FOR ALL TO classnest_app USING (true) WITH CHECK (true)',tbl);
    END IF;
  END LOOP;
END $$;
