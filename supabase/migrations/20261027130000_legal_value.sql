-- The Legal Team is a new assistant id. A new enum value cannot be used in the transaction that adds it,
-- so this file holds only the value; 20261027130010_legal.sql uses it.
alter type public.assistant_id add value if not exists 'legal';
