-- Run as the project owner after the deployment is live and the worker secret
-- has been inserted in Supabase Vault as classnest-email-worker-secret.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='classnest-email-worker-secret') THEN
    RAISE EXCEPTION 'Configure the private email worker secret first';
  END IF;
END $$;
SELECT cron.schedule('classnest-email-delivery','*/5 * * * *',
  $job$
    SELECT net.http_post(
      url:='https://pusoe.vercel.app/api/internal/email-delivery',
      headers:=jsonb_build_object(
        'Content-Type','application/json',
        'X-Classnest-Request','1',
        'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='classnest-email-worker-secret')
      ),
      body:='{}'::jsonb,
      timeout_milliseconds:=120000
    );
  $job$
);
