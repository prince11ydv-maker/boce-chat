-- Apply once as the project owner; set its random password separately as a secret.
CREATE ROLE classnest_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;
GRANT CONNECT ON DATABASE postgres TO classnest_app;
GRANT USAGE ON SCHEMA public TO classnest_app;
ALTER ROLE classnest_app SET search_path TO public,pg_catalog;
ALTER ROLE classnest_app SET statement_timeout TO '30s';
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['settings','semesters','users','sessions','auth_failures','rate_limits','subjects','notes','notices','threads','replies','events','upload_tickets','routines'] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO classnest_app',tbl);
    EXECUTE format('CREATE POLICY classnest_server ON public.%I FOR ALL TO classnest_app USING (true) WITH CHECK (true)',tbl);
  END LOOP;
END $$;
