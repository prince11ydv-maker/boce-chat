-- Preserve the existing endpoint, headers and Vault reference. Only cadence changes.
DO $$ DECLARE existing_job bigint; BEGIN
  SELECT jobid INTO existing_job FROM cron.job WHERE jobname='classnest-email-delivery';
  IF existing_job IS NULL THEN RAISE EXCEPTION 'Configure the existing authenticated email worker first'; END IF;
  PERFORM cron.alter_job(existing_job,schedule := '* * * * *');
END $$;
