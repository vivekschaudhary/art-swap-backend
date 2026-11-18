-- Turn on row-level security for every application table, with no policies.
-- Supabase exposes public tables through its own REST interface to the anon and
-- authenticated roles. With row-level security on and no policies, those roles see
-- nothing. The API connects as the table owner, which bypasses row-level security,
-- so the app is unaffected.

alter table if exists account enable row level security;
alter table if exists blocks enable row level security;
alter table if exists categories enable row level security;
alter table if exists conversation_participants enable row level security;
alter table if exists conversations enable row level security;
alter table if exists idempotency_keys enable row level security;
alter table if exists item_media enable row level security;
alter table if exists items enable row level security;
alter table if exists messages enable row level security;
alter table if exists notifications enable row level security;
alter table if exists passkey enable row level security;
alter table if exists profiles enable row level security;
alter table if exists schema_migrations enable row level security;
alter table if exists session enable row level security;
alter table if exists swap_events enable row level security;
alter table if exists swap_items enable row level security;
alter table if exists swap_participants enable row level security;
alter table if exists swaps enable row level security;
alter table if exists swipes enable row level security;
alter table if exists "user" enable row level security;
alter table if exists user_locations enable row level security;
alter table if exists verification enable row level security;
