-- Outbox recovery (adversarial review, finding 4): record when an item was claimed, so an item left in
-- 'sending' by a crash can be found and closed (marked failed, code blanked) instead of sitting there
-- forever. Items are never re-sent automatically after a crash: delivery stays at most once.
alter table public.outbox add column claimed_at timestamptz;
create index outbox_sending on public.outbox (claimed_at) where status = 'sending';
