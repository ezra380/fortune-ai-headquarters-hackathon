-- Review fixes for the profiles migration (20261027100000), 2026-10-27. Additive: it replaces the body of two helper
-- functions and nothing else (same names and signatures, so their privileges stay as that migration set them).
--
--  1. redact_text masked only phone numbers written one particular way. It now masks any ten-digit US/Canada number in
--     any spacing ("(718)555-1234", "718 5551234", "718-5551234", "+1 718 555 1234") and a six-digit code written in two
--     groups ("482-913", "482 913"). The same two shapes are in packages/contracts/src/redact.ts, which the lesson rules
--     and the read tools use; a test runs the same strings through both and requires the same answer.
--  2. door_check_list accepted extra keys in a list item and stored them without masking a number written as a number.
--     An item now holds the one field and nothing else.

create or replace function public.redact_text(p_text text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(
    regexp_replace(p_text,
      '\+\d[\d ().-]{7,18}\d|(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)', '[phone]', 'g'),
    '(?<![\d.,$])\d{3}[ -]?\d{3}(?!\d)(?!\.\d)', '[code]', 'g')
$$;

create or replace function public.door_check_list(p_list jsonb, p_name text, p_max integer, p_field text, p_field_max integer) returns void
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
  -- Only now is every item known to be an object. Nothing but the one field: another key would be stored unchecked.
  if exists (
    select 1 from jsonb_array_elements(p_list) e, jsonb_object_keys(e) k where k <> p_field
  ) then
    raise exception 'Every item in the report''s % has a "%" and nothing else.', p_name, p_field using errcode = '22023';
  end if;
end $$;

notify pgrst, 'reload schema';
