-- The HQ Manager is a new assistant id. A new enum value cannot be used in the transaction that adds
-- it, so this file holds only the value; 20261027000100_manager.sql uses it.
alter type public.assistant_id add value if not exists 'manager';
