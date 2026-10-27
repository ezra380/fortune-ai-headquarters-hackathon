-- Synthetic seed. Phone numbers are fictional 555 numbers. Real demo phones are registered locally
-- from .env.local by scripts/register-demo-phones.ts and are never committed.
-- Each division's assistant is its manager (George, Georgette, Cindy; docs/wave2.md), and each head is a
-- synthetic stand-in for the person the manager reports to (Alan, Emma, Esther): a name only, no real phone or email.
insert into public.assistants (id, display_name, sms_from) values
  ('owner',   'Joey (CEO)',           '+15550100001'),
  ('finance', 'George (finance)',     '+15550100002'),
  ('salon',   'Cindy (salon)',        '+15550100003'),
  ('online',  'Georgette (online)',   '+15550100004');

insert into public.people (id, name, role, phone, assistant_id) values
  ('demo-p-owner',         'Demo Owner',         'owner',         '+15550111001', 'owner'),
  ('demo-p-finance-owner', 'Demo Alan',          'finance_owner', '+15550111002', 'finance'),
  ('demo-p-head-stylist',  'Demo Esther',        'head_stylist',  '+15550111003', 'salon'),
  ('demo-p-online-staff',  'Demo Emma',          'online_staff',  '+15550111004', 'online');
