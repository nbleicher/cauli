create unique index export_jobs_one_format_per_call
  on public.export_jobs (call_id, format);
