alter table public.workspaces
  add column legal_gate_required boolean not null default false;

alter table public.workspace_members
  add column is_initial_admin boolean not null default false;

alter table public.workspace_members
  add constraint workspace_members_initial_admin_role
  check (not is_initial_admin or role = 'admin');

create unique index workspace_members_one_initial_admin
  on public.workspace_members (workspace_id)
  where is_initial_admin;

create table public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  document_type text not null unique
    check (document_type in (
      'terms',
      'privacy',
      'dpa',
      'recording_responsibilities',
      'subprocessors',
      'retention_deletion',
      'security_incident'
    )),
  title text not null check (char_length(title) between 1 and 120),
  required_for_all boolean not null default false,
  required_for_initial_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.legal_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.legal_documents(id),
  version text not null check (version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$'),
  content_markdown text not null check (char_length(content_markdown) between 1 and 100000),
  content_sha256 text not null
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  is_material boolean not null default true,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  effective_at timestamptz,
  operator_approved_at timestamptz,
  operator_approval_reference text
    check (
      operator_approval_reference is null
      or char_length(operator_approval_reference) between 1 and 240
    ),
  unique (document_id, version),
  check (
    (published_at is null and effective_at is null)
    or (
      published_at is not null
      and effective_at is not null
      and operator_approved_at is not null
      and operator_approval_reference is not null
    )
  )
);

create table public.legal_acceptances (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  user_id uuid not null,
  document_version_id uuid not null references public.legal_document_versions(id),
  accepted_at timestamptz not null default now(),
  unique (user_id, document_version_id)
);

create index legal_versions_current_idx
  on public.legal_document_versions (
    document_id,
    effective_at desc,
    published_at desc
  )
  where published_at is not null
    and operator_approved_at is not null;
create index legal_acceptances_user_idx
  on public.legal_acceptances (user_id, document_version_id);

create or replace function public.verify_legal_content_hash()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.content_sha256 <> encode(
    extensions.digest(new.content_markdown, 'sha256'),
    'hex'
  ) then
    raise exception 'Legal Document Version content hash does not match';
  end if;
  return new;
end;
$$;

create trigger legal_version_content_hash
before insert or update on public.legal_document_versions
for each row execute function public.verify_legal_content_hash();

create or replace function public.protect_legal_record()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Legal versions and acceptances are immutable';
end;
$$;

create trigger legal_acceptances_immutable
before update or delete on public.legal_acceptances
for each row execute function public.protect_legal_record();

create or replace function public.protect_published_legal_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.published_at is not null then
    raise exception 'Published Legal Document Versions are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger published_legal_versions_immutable
before update or delete on public.legal_document_versions
for each row execute function public.protect_published_legal_version();

alter table public.legal_documents enable row level security;
alter table public.legal_document_versions enable row level security;
alter table public.legal_acceptances enable row level security;

grant select on public.legal_documents, public.legal_document_versions
  to anon, authenticated, service_role;
grant select on public.legal_acceptances to authenticated, service_role;
grant all privileges on public.legal_documents, public.legal_document_versions
  to service_role;
grant usage, select on sequence public.legal_acceptances_id_seq
  to service_role;

create policy legal_documents_public_read
on public.legal_documents for select
to anon, authenticated
using (true);

create policy legal_versions_public_read
on public.legal_document_versions for select
to anon, authenticated
using (true);

create policy legal_acceptances_scoped_read
on public.legal_acceptances for select
to authenticated
using (
  user_id = auth.uid()
  or public.current_user_role(workspace_id) = 'admin'
);

revoke insert, update, delete, truncate
  on public.legal_documents, public.legal_document_versions
  from public, anon, authenticated;
revoke insert, update, delete, truncate
  on public.legal_acceptances
  from public, anon, authenticated, service_role;

insert into public.legal_documents (
  slug,
  document_type,
  title,
  required_for_all,
  required_for_initial_admin
) values
  ('terms', 'terms', 'Pilot Terms of Service', true, false),
  ('privacy', 'privacy', 'Pilot Privacy Notice', true, false),
  ('dpa', 'dpa', 'Pilot Data Processing Addendum', false, true),
  (
    'recording-responsibilities',
    'recording_responsibilities',
    'Recording Responsibilities',
    false,
    true
  ),
  ('subprocessors', 'subprocessors', 'Pilot Subprocessors', false, false),
  (
    'retention-deletion',
    'retention_deletion',
    'Retention and Deletion',
    false,
    false
  ),
  (
    'security',
    'security_incident',
    'Pilot Security and Incident Contact',
    false,
    false
  );

insert into public.legal_document_versions (
  document_id,
  version,
  content_markdown,
  content_sha256,
  is_material
)
select
  document.id,
  'pilot-draft-1',
  case document.document_type
    when 'terms' then
      'These draft Pilot Terms describe access to Cauli’s controlled pilot, account responsibilities, acceptable use, service changes, fees if applicable, disclaimers, liability allocation, termination, and governing terms. They require operator review before publication.'
    when 'privacy' then
      'This draft Privacy Notice describes account data, browser-recorded audio, Transcripts, Reviews, operational metadata, subprocessors, purposes, retention, deletion, security contacts, and individual requests. Persistent production systems are intended for verified U.S. regions; OpenRouter and model providers may process data transiently outside the United States.'
    when 'dpa' then
      'This draft Data Processing Addendum describes controller and processor roles, documented instructions, confidentiality, security measures, subprocessors, incident cooperation, deletion, audits, and international transient model processing. It requires operator review before publication.'
    when 'recording_responsibilities' then
      'Workspace Members are responsible for determining and satisfying the notices, permissions, consents, and other legal obligations that apply before recording. Cauli’s Recording Attestation records the Member’s statement; checking it does not independently make a recording lawful.'
    when 'subprocessors' then
      'The draft pilot subprocessor inventory covers Railway, Supabase, Cloudflare, OpenRouter and applicable model providers, Sentry, Netcup, AWS KMS, and the email provider used by Supabase Auth. Exact entities and purposes require operator verification before publication.'
    when 'retention_deletion' then
      'This draft describes Workspace retention configuration, deletion queues, backup expiry, Audit Event retention, account offboarding, and support-assisted requests. Exact periods require operator verification before publication.'
    when 'security_incident' then
      'Cauli uses scoped identities, encryption services, private Storage, role-aware access controls, Audit Events, backups, monitoring, and incident procedures as described by the current deployed controls. Security and incident contact details require operator verification before publication.'
  end
  || E'\n\n'
  || 'Cauli’s pilot has not been independently assessed, certified, or contractually approved for HIPAA, PCI DSS, FedRAMP, CUI, FERPA, COPPA, GLBA, GDPR-specific, or similar regulated workloads.',
  encode(
    extensions.digest(
      case document.document_type
        when 'terms' then
          'These draft Pilot Terms describe access to Cauli’s controlled pilot, account responsibilities, acceptable use, service changes, fees if applicable, disclaimers, liability allocation, termination, and governing terms. They require operator review before publication.'
        when 'privacy' then
          'This draft Privacy Notice describes account data, browser-recorded audio, Transcripts, Reviews, operational metadata, subprocessors, purposes, retention, deletion, security contacts, and individual requests. Persistent production systems are intended for verified U.S. regions; OpenRouter and model providers may process data transiently outside the United States.'
        when 'dpa' then
          'This draft Data Processing Addendum describes controller and processor roles, documented instructions, confidentiality, security measures, subprocessors, incident cooperation, deletion, audits, and international transient model processing. It requires operator review before publication.'
        when 'recording_responsibilities' then
          'Workspace Members are responsible for determining and satisfying the notices, permissions, consents, and other legal obligations that apply before recording. Cauli’s Recording Attestation records the Member’s statement; checking it does not independently make a recording lawful.'
        when 'subprocessors' then
          'The draft pilot subprocessor inventory covers Railway, Supabase, Cloudflare, OpenRouter and applicable model providers, Sentry, Netcup, AWS KMS, and the email provider used by Supabase Auth. Exact entities and purposes require operator verification before publication.'
        when 'retention_deletion' then
          'This draft describes Workspace retention configuration, deletion queues, backup expiry, Audit Event retention, account offboarding, and support-assisted requests. Exact periods require operator verification before publication.'
        when 'security_incident' then
          'Cauli uses scoped identities, encryption services, private Storage, role-aware access controls, Audit Events, backups, monitoring, and incident procedures as described by the current deployed controls. Security and incident contact details require operator verification before publication.'
      end
      || E'\n\n'
      || 'Cauli’s pilot has not been independently assessed, certified, or contractually approved for HIPAA, PCI DSS, FedRAMP, CUI, FERPA, COPPA, GLBA, GDPR-specific, or similar regulated workloads.',
      'sha256'
    ),
    'hex'
  ),
  true
from public.legal_documents document;

create or replace function public.enforce_legal_gate_readiness()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  approved_core_document_count integer;
begin
  if new.legal_gate_required
    and (tg_op = 'INSERT' or not old.legal_gate_required)
  then
    select count(distinct document.document_type)
    into approved_core_document_count
    from public.legal_documents document
    where document.document_type in (
      'terms',
      'privacy',
      'dpa',
      'recording_responsibilities'
    )
      and exists (
        select 1
        from public.legal_document_versions version
        where version.document_id = document.id
          and version.published_at is not null
          and version.operator_approved_at is not null
          and version.effective_at <= now()
      );

    if approved_core_document_count <> 4 then
      raise exception 'The legal gate requires four operator-approved core Legal Documents';
    end if;
  end if;
  return new;
end;
$$;

create trigger workspaces_legal_gate_readiness
before insert or update of legal_gate_required on public.workspaces
for each row execute function public.enforce_legal_gate_readiness();

create or replace function public.required_legal_documents_for_current_user()
returns table (
  document_type text,
  slug text,
  title text,
  version_id uuid,
  version text,
  content_sha256 text,
  accepted_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with membership as (
    select workspace_id, is_initial_admin
    from public.workspace_members
    where user_id = auth.uid()
      and status = 'active'
    limit 1
  ),
  current_versions as (
    select distinct on (document.id)
      document.id as document_id,
      document.document_type,
      document.slug,
      document.title,
      version.id as version_id,
      version.version,
      version.content_sha256
    from public.legal_documents document
    join public.legal_document_versions version
      on version.document_id = document.id
    cross join membership
    where (
        document.required_for_all
        or (
          document.required_for_initial_admin
          and membership.is_initial_admin
        )
      )
      and version.published_at is not null
      and version.operator_approved_at is not null
      and version.effective_at <= now()
    order by
      document.id,
      version.effective_at desc,
      version.published_at desc,
      version.created_at desc
  )
  select
    current.document_type,
    current.slug,
    current.title,
    current.version_id,
    current.version,
    current.content_sha256,
    acceptance.accepted_at
  from current_versions current
  left join public.legal_acceptances acceptance
    on acceptance.user_id = auth.uid()
   and acceptance.document_version_id = current.version_id
  order by current.document_type;
$$;

create or replace function public.legal_gate_satisfied_for_current_user()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  gate_required boolean;
  initial_admin boolean;
  required_count integer;
  missing_count integer;
begin
  select workspace.legal_gate_required, member.is_initial_admin
  into gate_required, initial_admin
  from public.workspace_members member
  join public.workspaces workspace on workspace.id = member.workspace_id
  where member.user_id = auth.uid()
    and member.status = 'active';

  if gate_required is null then
    return false;
  end if;
  if not gate_required then
    return true;
  end if;

  select
    count(*),
    count(*) filter (where accepted_at is null)
  into required_count, missing_count
  from public.required_legal_documents_for_current_user();

  return required_count = case when initial_admin then 4 else 2 end
    and missing_count = 0;
end;
$$;

create or replace function public.accept_current_legal_documents(
  target_version_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_workspace_id uuid;
  actor_is_initial_admin boolean;
  expected_count integer;
  required_count integer;
  supplied_required_count integer;
  accepted_count integer := 0;
  required_record record;
begin
  select workspace_id, is_initial_admin
  into actor_workspace_id, actor_is_initial_admin
  from public.workspace_members
  where user_id = auth.uid()
    and status = 'active';
  if actor_workspace_id is null then
    raise exception 'Active Workspace membership is required';
  end if;
  expected_count := case when actor_is_initial_admin then 4 else 2 end;

  select count(*) into required_count
  from public.required_legal_documents_for_current_user();
  select count(*) into supplied_required_count
  from public.required_legal_documents_for_current_user()
  where version_id = any(target_version_ids);

  if required_count <> expected_count
    or supplied_required_count <> required_count
    or cardinality(target_version_ids) <> required_count
  then
    raise exception 'Every current required Legal Document Version must be accepted';
  end if;

  for required_record in
    select *
    from public.required_legal_documents_for_current_user()
    where version_id = any(target_version_ids)
  loop
    insert into public.legal_acceptances (
      workspace_id,
      user_id,
      document_version_id
    ) values (
      actor_workspace_id,
      auth.uid(),
      required_record.version_id
    )
    on conflict (user_id, document_version_id) do nothing;

    if found then
      accepted_count := accepted_count + 1;
      perform public.record_audit_event(
        actor_workspace_id,
        auth.uid(),
        'legal.acceptance.recorded',
        'legal_document_version',
        required_record.version_id::text,
        jsonb_build_object(
          'document_type', required_record.document_type,
          'version', required_record.version
        )
      );
    end if;
  end loop;
  return accepted_count;
end;
$$;

create or replace function public.legal_package_ready(
  target_workspace_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    workspace.legal_gate_required
    and (
      select count(distinct document.document_type) = 4
      from public.legal_documents document
      where document.document_type in (
        'terms',
        'privacy',
        'dpa',
        'recording_responsibilities'
      )
        and exists (
          select 1
          from public.legal_document_versions version
          where version.document_id = document.id
            and version.published_at is not null
            and version.operator_approved_at is not null
            and version.effective_at <= now()
        )
    )
  from public.workspaces workspace
  where workspace.id = target_workspace_id;
$$;

revoke all on function public.required_legal_documents_for_current_user()
  from public, anon;
grant execute on function public.required_legal_documents_for_current_user()
  to authenticated;
revoke all on function public.legal_gate_satisfied_for_current_user()
  from public, anon;
grant execute on function public.legal_gate_satisfied_for_current_user()
  to authenticated;
revoke all on function public.accept_current_legal_documents(uuid[])
  from public, anon;
grant execute on function public.accept_current_legal_documents(uuid[])
  to authenticated;
revoke all on function public.legal_package_ready(uuid)
  from public, anon, authenticated;
grant execute on function public.legal_package_ready(uuid)
  to service_role;
