/**
 * #20's budget controls become reachable only through #34's hardened Platform
 * Admin boundary. The bootstrap definitions in 1002 are service-role-only so
 * there is no interval in which a Workspace identity can promote itself.
 */

create or replace function public.set_platform_processing_budget(
  target_daily_limit_usd numeric,
  target_warning_ratio numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_environment public.platform_environment;
  updated public.platform_processing_budget;
  resumed integer;
begin
  target_environment := public.assert_current_platform_admin(true);

  if target_daily_limit_usd is null or target_daily_limit_usd < 0 then
    raise exception 'A platform budget must be zero or more';
  end if;

  update public.platform_processing_budget
  set daily_limit_usd = target_daily_limit_usd,
      warning_ratio = coalesce(target_warning_ratio, warning_ratio),
      updated_at = now(),
      updated_by = auth.uid()
  where singleton
  returning * into updated;

  perform public.record_platform_audit_event(
    target_environment,
    auth.uid(),
    'platform.budget.changed',
    'platform_budget',
    'daily',
    jsonb_build_object(
      'limit_usd', updated.daily_limit_usd,
      'threshold_ratio', updated.warning_ratio
    )
  );

  resumed := public.resume_budget_paused_jobs();

  return jsonb_build_object(
    'dailyLimitUsd', updated.daily_limit_usd,
    'warningRatio', updated.warning_ratio,
    'resumedJobs', resumed
  );
end;
$$;

create or replace function public.set_workspace_processing_budget(
  target_workspace_id uuid,
  target_daily_limit_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_environment public.platform_environment;
  resumed integer;
begin
  target_environment := public.assert_current_platform_admin(true);

  if target_daily_limit_usd is null or target_daily_limit_usd < 0 then
    raise exception 'A Workspace budget must be zero or more';
  end if;

  insert into public.workspace_processing_budget (
    workspace_id, daily_limit_usd, updated_by
  )
  values (target_workspace_id, target_daily_limit_usd, auth.uid())
  on conflict (workspace_id) do update
  set daily_limit_usd = excluded.daily_limit_usd,
      updated_at = now(),
      updated_by = excluded.updated_by;

  -- The affected Workspace sees the change that can pause its Calls.
  perform public.record_audit_event(
    target_workspace_id,
    auth.uid(),
    'platform.budget.changed',
    'workspace_budget',
    target_workspace_id::text,
    jsonb_build_object(
      'limit_usd', target_daily_limit_usd,
      'platform_environment', target_environment::text
    )
  );

  resumed := public.resume_budget_paused_jobs();

  return jsonb_build_object(
    'dailyLimitUsd', target_daily_limit_usd,
    'resumedJobs', resumed
  );
end;
$$;

create or replace function public.set_provider_pricing(
  target_model text,
  target_usd_per_audio_minute numeric,
  target_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_environment public.platform_environment;
begin
  target_environment := public.assert_current_platform_admin(true);

  if target_usd_per_audio_minute is null
    or target_usd_per_audio_minute < 0 then
    raise exception 'Provider pricing must be zero or more';
  end if;

  insert into public.provider_pricing (
    model, usd_per_audio_minute, is_active, updated_by
  )
  values (
    target_model, target_usd_per_audio_minute, target_is_active, auth.uid()
  )
  on conflict (model) do update
  set usd_per_audio_minute = excluded.usd_per_audio_minute,
      is_active = excluded.is_active,
      updated_at = now(),
      updated_by = excluded.updated_by;

  perform public.record_platform_audit_event(
    target_environment,
    auth.uid(),
    'platform.pricing.changed',
    'provider_pricing',
    target_model,
    jsonb_build_object(
      'usd_per_audio_minute', target_usd_per_audio_minute,
      'active', target_is_active
    )
  );

  return jsonb_build_object(
    'model', target_model,
    'usdPerAudioMinute', target_usd_per_audio_minute,
    'active', target_is_active
  );
end;
$$;

-- Threshold evidence names the affected Workspace and contains only bounded
-- numbers. It therefore belongs in that Workspace's Audit Log even when the
-- threshold crossed was the platform-wide ceiling.
create or replace function private.warn_on_budget_threshold(
  charge_date date,
  target_workspace_id uuid,
  workspace_spent numeric,
  workspace_limit numeric,
  platform_spent numeric,
  platform_limit numeric
)
returns void
language plpgsql
set search_path = public
as $$
declare
  ratio numeric := public.processing_budget_warning_ratio();
  claimed integer;
begin
  if workspace_limit > 0 and workspace_spent >= ratio * workspace_limit then
    insert into public.processing_budget_warnings (spend_date, scope_key)
    values (charge_date, target_workspace_id::text)
    on conflict do nothing;
    get diagnostics claimed = row_count;
    if claimed > 0 then
      perform public.record_audit_event(
        target_workspace_id,
        null,
        'processing.budget.warned',
        'workspace_budget',
        target_workspace_id::text,
        jsonb_build_object(
          'scope', 'workspace',
          'threshold_ratio', ratio,
          'limit_usd', workspace_limit,
          'spent_usd', round(workspace_spent, 6)
        )
      );
    end if;
  end if;

  if platform_limit > 0 and platform_spent >= ratio * platform_limit then
    insert into public.processing_budget_warnings (spend_date, scope_key)
    values (charge_date, 'platform')
    on conflict do nothing;
    get diagnostics claimed = row_count;
    if claimed > 0 then
      perform public.record_audit_event(
        target_workspace_id,
        null,
        'processing.budget.warned',
        'platform_budget',
        charge_date::text,
        jsonb_build_object(
          'scope', 'platform',
          'threshold_ratio', ratio,
          'limit_usd', platform_limit,
          'spent_usd', round(platform_spent, 6)
        )
      );
    end if;
  end if;
end;
$$;

-- Kept only for migration compatibility with already-created databases; no
-- runtime principal may use the obsolete reserved-Workspace scope.
revoke all on function public.platform_audit_scope()
  from public, anon, authenticated;

revoke all on function public.set_platform_processing_budget(numeric, numeric)
  from public, anon;
grant execute on function public.set_platform_processing_budget(numeric, numeric)
  to authenticated, service_role;
revoke all on function public.set_workspace_processing_budget(uuid, numeric)
  from public, anon;
grant execute on function public.set_workspace_processing_budget(uuid, numeric)
  to authenticated, service_role;
revoke all on function public.set_provider_pricing(text, numeric, boolean)
  from public, anon;
grant execute on function public.set_provider_pricing(text, numeric, boolean)
  to authenticated, service_role;
