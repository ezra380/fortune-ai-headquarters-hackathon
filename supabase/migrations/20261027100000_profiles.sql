-- Assistant profiles in the database, the tokens outside AI tools use to read one, and the reports they file.
-- Synthetic data only. RLS is on for every new table with NO policies, and the Data API roles (anon,
-- authenticated) hold no table privileges at all: the only thing an outside tool can call with the
-- public anon key is door_profile(token) and door_file_report(token, report). Both are SECURITY DEFINER,
-- check the token's hash, and return or store nothing else. The worker and the scripts use the service role.

-- ---- Profiles ------------------------------------------------------------------------------------

-- One current profile per assistant. A row here replaces the file profile for that assistant; a missing row
-- means the worker uses the files (packages/profiles/skills). `version` counts every change ever made.
create table public.assistant_profiles (
  assistant_id public.assistant_id primary key references public.assistants (id),
  version integer not null check (version >= 1),
  title text not null check (length(title) between 1 and 80),
  skill text not null check (length(skill) between 40 and 12000),
  -- Names of read tools only (the worker checks each one against its fixed list). Never a write.
  reads text[] not null check (cardinality(reads) <= 30 and array_to_string(reads, ',') ~ '^([a-z_]+(,[a-z_]+)*)?$'),
  -- { "<job>": { "model": ..., "thinking": ..., "maxTokens": ..., "temperature": ... } }
  models jsonb not null check (jsonb_typeof(models) = 'object'),
  -- [{ "text": ..., "source": ..., "adoptedAt": ... }], the standing lessons a person adopted.
  lessons jsonb not null default '[]'::jsonb check (jsonb_typeof(lessons) = 'array' and jsonb_array_length(lessons) <= 50),
  updated_at timestamptz not null default now(),
  updated_by text not null check (updated_by in ('seed', 'manager', 'owner'))
);

-- Every version of every profile, forever. Nothing here is updated, deleted or truncated.
create table public.assistant_profile_versions (
  id bigint generated always as identity primary key,
  assistant_id public.assistant_id not null references public.assistants (id),
  version integer not null check (version >= 1),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  change jsonb not null check (jsonb_typeof(change) = 'object'),
  made_by text not null check (made_by in ('seed', 'manager', 'owner')),
  reason text not null check (length(reason) between 1 and 300),
  created_at timestamptz not null default now(),
  unique (assistant_id, version)
);

create function public.refuse_profile_version_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'assistant_profile_versions is append-only: a version is never changed or removed'
    using errcode = '23001';
end $$;

create trigger assistant_profile_versions_append_only
  before update or delete on public.assistant_profile_versions
  for each row execute function public.refuse_profile_version_change();
create trigger assistant_profile_versions_no_truncate
  before truncate on public.assistant_profile_versions
  for each statement execute function public.refuse_profile_version_change();

-- ---- Doors ---------------------------------------------------------------------------------------

-- One row per token an outside tool holds. Only the SHA-256 of the token is stored, never the token.
create table public.door_tokens (
  id uuid primary key default gen_random_uuid(),
  assistant_id public.assistant_id not null references public.assistants (id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label text not null check (length(label) between 1 and 60),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- What an outside tool reports at the end of a session. The HQ Manager reads these (reviewed_at marks the ones it has).
create table public.session_reports (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.door_tokens (id),
  assistant_id public.assistant_id not null references public.assistants (id),
  tool text not null check (length(tool) between 1 and 60),
  summary text not null check (length(summary) between 1 and 2000),
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  suggestions jsonb not null default '[]'::jsonb check (jsonb_typeof(suggestions) = 'array'),
  lessons jsonb not null default '[]'::jsonb check (jsonb_typeof(lessons) = 'array'),
  -- A retry of the same report (same token, same key) is stored once.
  dedupe_key text check (dedupe_key ~ '^[A-Za-z0-9._:-]{8,80}$'),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create unique index session_reports_one_per_key on public.session_reports (token_id, dedupe_key) where dedupe_key is not null;
create index session_reports_unreviewed on public.session_reports (created_at) where reviewed_at is null;

alter table public.assistant_profiles enable row level security;
alter table public.assistant_profile_versions enable row level security;
alter table public.door_tokens enable row level security;
alter table public.session_reports enable row level security;

-- ---- Writing a profile (service role only) -------------------------------------------------------

-- The one way a profile changes. It writes the current row and appends the version in the same transaction.
--   p_expected_version null  : create the profile; refused (null) when one already exists.
--   p_expected_version n     : change the profile; refused (null) unless it is still at version n.
-- Returns the new version, or null when the guard refused, so two writers can never overwrite each other.
create function public.save_assistant_profile(
  p_assistant public.assistant_id, p_expected_version integer,
  p_title text, p_skill text, p_reads text[], p_models jsonb, p_lessons jsonb,
  p_by text, p_reason text, p_change jsonb default '{}'::jsonb, p_now timestamptz default now()
) returns integer
language plpgsql set search_path = '' as $$
declare v_version integer;
begin
  if p_expected_version is null then
    insert into public.assistant_profiles (assistant_id, version, title, skill, reads, models, lessons, updated_at, updated_by)
    values (p_assistant, 1, p_title, p_skill, p_reads, p_models, p_lessons, p_now, p_by)
    on conflict (assistant_id) do nothing;
  else
    update public.assistant_profiles
       set title = p_title, skill = p_skill, reads = p_reads, models = p_models, lessons = p_lessons,
           updated_at = p_now, updated_by = p_by
     where assistant_id = p_assistant and version = p_expected_version;
  end if;
  if not found then return null; end if;

  -- The row is locked by now, so no other writer can pick the same number.
  select coalesce(max(v.version), 0) + 1 into v_version
    from public.assistant_profile_versions v where v.assistant_id = p_assistant;
  update public.assistant_profiles set version = v_version where assistant_id = p_assistant;
  insert into public.assistant_profile_versions (assistant_id, version, snapshot, change, made_by, reason, created_at)
  values (p_assistant, v_version,
          jsonb_build_object('title', p_title, 'skill', p_skill, 'reads', to_jsonb(p_reads), 'models', p_models, 'lessons', p_lessons),
          p_change, p_by, p_reason, p_now);
  return v_version;
end $$;

-- ---- Redaction ------------------------------------------------------------------------------------

-- Phone numbers and one-time codes never reach a table through a door. Over-masking is the safe side:
-- any ten-digit number, any formatted phone number and any lone six-digit group is replaced.
create function public.redact_text(p_text text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(p_text, '\+\d[\d ().-]{7,18}\d', '[phone]', 'g'),
        '(?<!\d)\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)', '[phone]', 'g'),
      '(?<!\d)1?\d{10}(?!\d)', '[phone]', 'g'),
    '(?<![\d.,$])\d{6}(?!\d)(?!\.\d)', '[code]', 'g')
$$;

-- The same, for every string and every key in a JSON value (numbers and booleans are left alone).
create function public.redact_json(p_value jsonb, p_depth integer default 0) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_out jsonb;
begin
  if p_depth > 6 then
    raise exception 'The report is nested too deeply.' using errcode = '22023';
  end if;
  case jsonb_typeof(p_value)
    when 'string' then
      return to_jsonb(public.redact_text(p_value #>> '{}'));
    when 'array' then
      select coalesce(jsonb_agg(public.redact_json(e.value, p_depth + 1) order by e.ordinality), '[]'::jsonb)
        into v_out from jsonb_array_elements(p_value) with ordinality as e(value, ordinality);
      return v_out;
    when 'object' then
      select coalesce(jsonb_object_agg(public.redact_text(e.key), public.redact_json(e.value, p_depth + 1)), '{}'::jsonb)
        into v_out from jsonb_each(p_value) as e(key, value);
      return v_out;
    else
      return p_value;
  end case;
end $$;

-- ---- The two doors (anon may call exactly these) -----------------------------------------------------

-- The token's row, or an error that does not say which part was wrong. Used by both doors.
-- The Data API runs a GET inside a read-only transaction, so refusing those keeps a token out of URLs (which get logged).
create function public.door_token(p_token text) returns public.door_tokens
language plpgsql security definer set search_path = '' as $$
declare v_row public.door_tokens;
begin
  if current_setting('transaction_read_only') = 'on' then
    raise exception 'Send the token in a POST body, never in a URL.' using errcode = '25006';
  end if;
  if p_token is not null and p_token ~ '^[A-Za-z0-9_-]{32,128}$' then
    select * into v_row from public.door_tokens t
     where t.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and t.revoked_at is null;
  end if;
  if v_row.id is null then
    raise exception 'This token is not valid.' using errcode = '28000';
  end if;
  return v_row;
end $$;

-- The profile of the assistant this token belongs to: its skill, reads, models and lessons.
create function public.door_profile(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token public.door_tokens := public.door_token(p_token);
  v_profile public.assistant_profiles;
begin
  select * into v_profile from public.assistant_profiles p where p.assistant_id = v_token.assistant_id;
  if v_profile.assistant_id is null then
    raise exception 'No profile is stored for this assistant yet.' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'assistant', v_profile.assistant_id, 'title', v_profile.title, 'version', v_profile.version,
    'skill', v_profile.skill, 'reads', to_jsonb(v_profile.reads), 'models', v_profile.models, 'lessons', v_profile.lessons);
end $$;

-- A list of objects, each with a text field of the right length. Raises a plain sentence when it is not.
create function public.door_check_list(p_list jsonb, p_name text, p_max integer, p_field text, p_field_max integer) returns void
language plpgsql immutable set search_path = '' as $$
begin
  -- Two separate tests: SQL does not promise to stop at the first half of an OR, and the length of a non-list is an error.
  if jsonb_typeof(p_list) <> 'array' then
    raise exception 'The report''s % must be a list of at most % items.', p_name, p_max using errcode = '22023';
  end if;
  if jsonb_array_length(p_list) > p_max then
    raise exception 'The report''s % must be a list of at most % items.', p_name, p_max using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_list) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(jsonb_typeof(e -> p_field), '') <> 'string'
        or length(e ->> p_field) not between 1 and p_field_max
  ) then
    raise exception 'Every item in the report''s % needs a "%" of 1 to % characters.', p_name, p_field, p_field_max using errcode = '22023';
  end if;
end $$;

-- Files a session report. Shape and size are checked first, then phone numbers and codes are masked, then the
-- report is stored once per (token, key). Returns { id, duplicate }.
create function public.door_file_report(p_token text, p_report jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token public.door_tokens := public.door_token(p_token);
  v_report jsonb;
  v_key text;
  v_id uuid;
begin
  if p_report is null or jsonb_typeof(p_report) <> 'object' then
    raise exception 'The report must be a JSON object.' using errcode = '22023';
  end if;
  if octet_length(p_report::text) > 32768 then
    raise exception 'The report is larger than 32 KB.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_report) k where k not in ('key', 'tool', 'summary', 'steps', 'suggestions', 'lessons')) then
    raise exception 'The report has a field this door does not accept (allowed: key, tool, summary, steps, suggestions, lessons).' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_report -> 'tool'), '') <> 'string' or length(p_report ->> 'tool') not between 1 and 60 then
    raise exception 'The report needs a "tool" of 1 to 60 characters.' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_report -> 'summary'), '') <> 'string' or length(p_report ->> 'summary') not between 1 and 2000 then
    raise exception 'The report needs a "summary" of 1 to 2000 characters.' using errcode = '22023';
  end if;
  v_key := p_report ->> 'key';
  if p_report ? 'key' and (coalesce(jsonb_typeof(p_report -> 'key'), '') <> 'string' or v_key !~ '^[A-Za-z0-9._:-]{8,80}$') then
    raise exception 'The report''s "key" must be 8 to 80 letters, digits or . _ : -' using errcode = '22023';
  end if;
  perform public.door_check_list(coalesce(p_report -> 'steps', '[]'::jsonb), 'steps', 30, 'step', 80);
  perform public.door_check_list(coalesce(p_report -> 'suggestions', '[]'::jsonb), 'suggestions', 10, 'text', 300);
  perform public.door_check_list(coalesce(p_report -> 'lessons', '[]'::jsonb), 'lessons', 10, 'text', 300);

  -- A leaked token cannot flood the table.
  if (select count(*) from public.session_reports r where r.token_id = v_token.id and r.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'This token has filed 60 reports in the last hour. Try again later.' using errcode = '54000';
  end if;

  v_report := public.redact_json(p_report);
  insert into public.session_reports (token_id, assistant_id, tool, summary, steps, suggestions, lessons, dedupe_key)
  values (v_token.id, v_token.assistant_id, v_report ->> 'tool', v_report ->> 'summary',
          coalesce(v_report -> 'steps', '[]'::jsonb), coalesce(v_report -> 'suggestions', '[]'::jsonb),
          coalesce(v_report -> 'lessons', '[]'::jsonb), v_key)
  on conflict (token_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'duplicate', false);
  end if;
  select r.id into v_id from public.session_reports r where r.token_id = v_token.id and r.dedupe_key = v_key;
  return jsonb_build_object('id', v_id, 'duplicate', true);
end $$;

-- ---- Privileges ------------------------------------------------------------------------------------------

-- Supabase grants every table in public to anon and authenticated by default; RLS alone kept them out. Now they
-- hold nothing: not on today's tables, and not on tables made later by this role.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- The worker and the scripts use the service role: say what it may do here rather than rely on the stack's defaults.
grant select, insert, update, delete on public.assistant_profiles, public.door_tokens, public.session_reports to service_role;
grant select, insert on public.assistant_profile_versions to service_role;
grant usage on sequence public.assistant_profile_versions_id_seq to service_role;
-- A version is never changed or removed, not even by the service role (the trigger holds for everyone else).
revoke update, delete, truncate on public.assistant_profile_versions from service_role;

revoke all on function public.refuse_profile_version_change() from public, anon, authenticated;
revoke all on function public.save_assistant_profile(public.assistant_id, integer, text, text, text[], jsonb, jsonb, text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.redact_text(text) from public, anon, authenticated;
revoke all on function public.redact_json(jsonb, integer) from public, anon, authenticated;
revoke all on function public.door_token(text) from public, anon, authenticated;
revoke all on function public.door_check_list(jsonb, text, integer, text, integer) from public, anon, authenticated;
revoke all on function public.door_profile(text) from public, anon, authenticated;
revoke all on function public.door_file_report(text, jsonb) from public, anon, authenticated;

grant execute on function public.save_assistant_profile(public.assistant_id, integer, text, text, text[], jsonb, jsonb, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.door_profile(text) to anon, service_role;
grant execute on function public.door_file_report(text, jsonb) to anon, service_role;

notify pgrst, 'reload schema';
