-- Synthetic seed. Phone numbers are fictional 555 numbers. Real demo phones are registered locally
-- from .env.local by scripts/register-demo-phones.ts and are never committed.
insert into public.assistants (id, display_name, sms_from) values
  ('owner',   'Owner''s assistant',   '+15550100001'),
  ('finance', 'Finance assistant',    '+15550100002'),
  ('salon',   'Cindy (salon)',        '+15550100003'),
  ('online',  'Online assistant',     '+15550100004');

insert into public.people (id, name, role, phone, assistant_id) values
  ('demo-p-owner',         'Demo Owner',         'owner',         '+15550111001', 'owner'),
  ('demo-p-finance-owner', 'Demo Finance Owner', 'finance_owner', '+15550111002', 'finance'),
  ('demo-p-head-stylist',  'Demo Head Stylist',  'head_stylist',  '+15550111003', 'salon'),
  ('demo-p-online-staff',  'Demo Online Staff',  'online_staff',  '+15550111004', 'online');
