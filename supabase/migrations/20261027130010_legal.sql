-- The Legal Team: terms, contracts and policies. Like the HQ Manager it has no phone number and no person: staff reach it
-- through a door token (door_profile, door_file_report), and the owner asks it by text through Owner HQ's number.
-- Its profile row is made by scripts/seed-profiles.ts (the files are the baseline); its door reports land in
-- session_reports under assistant_id 'legal', where the HQ Manager reads them with every other door's.
-- Synthetic data only. Nothing here touches a table's privileges: the public roles still hold none, and the two doors
-- are still the only functions anon may run.
insert into public.assistants (id, display_name, sms_from) values ('legal', 'Legal Team', null)
on conflict (id) do nothing;
