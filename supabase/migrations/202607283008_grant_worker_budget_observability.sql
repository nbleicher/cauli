-- The budget and service-level migrations precede creation of the dedicated
-- processing-worker role. Grant their runtime operations only after both sides
-- of that integration exist. Without these grants the real cauli_worker exits
-- at its pricing assertion and cannot resume budgets or serve /metrics, while
-- CI's service-role stand-in hides the failure.
grant execute on function
  public.assert_transcription_models_priced(text[]),
  public.resume_budget_paused_jobs(),
  public.processing_service_level(integer),
  public.processing_queue_age_seconds(),
  public.processing_operational_alerts()
to cauli_worker;
