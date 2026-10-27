-- The Legal Team (wave 2), review fix, 2026-10-27. Additive: it replaces the body of one helper function (same name and
-- signature, so the privileges migration 20261027100000 set stay as they are) and nothing else.
--
-- redact_text masked phone numbers and one-time codes in what an outside tool files (file_work_report). A contract names
-- its parties' notice addresses ("notices to legal@vendor.example"), and the Legal Team's door is the one most likely to
-- file one; those reports reach the HQ Manager's review model through the digest. redact_text now masks an email address
-- too, as [email], BEFORE the phone and code shapes so the digits inside an address are not read as a code. The same
-- pattern is EMAIL_SOURCE in packages/contracts/src/redact.ts; a test runs one list of strings through both.

create or replace function public.redact_text(p_text text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(p_text,
        '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', '[email]', 'g'),
      '\+\d[\d ().-]{7,18}\d|(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)', '[phone]', 'g'),
    '(?<![\d.,$])\d{3}[ -]?\d{3}(?!\d)(?!\.\d)', '[code]', 'g')
$$;

notify pgrst, 'reload schema';
