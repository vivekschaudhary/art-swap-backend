-- M5 swaps (docs/v1-design.md §5.5). No functions, triggers or rules (§1 principle 5).

create table swaps (
  id uuid primary key default gen_random_uuid(),
  requester_id text not null references "user" ("id") on delete cascade,
  recipient_id text not null references "user" ("id") on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'completed', 'declined', 'withdrawn', 'expired', 'unavailable', 'cancelled', 'disputed')),
  fulfillment_method text not null default 'local_pickup' check (fulfillment_method in ('local_pickup', 'shipping', 'either')),
  note text check (char_length(note) <= 500),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  closed_by text,
  close_reason text,
  parent_swap_id uuid references swaps ("id"),
  requires_payment boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_id <> recipient_id)
);

create index swaps_recipient_idx on swaps (recipient_id, status, created_at desc);
create index swaps_requester_idx on swaps (requester_id, status, created_at desc);
create index swaps_pending_expiry_idx on swaps (expires_at) where status = 'pending';

create table swap_items (
  swap_id uuid not null references swaps ("id") on delete cascade,
  item_id uuid not null references items ("id"),
  from_user_id text not null references "user" ("id"),
  to_user_id text not null references "user" ("id"),
  snapshot jsonb not null,
  resulting_item_id uuid references items ("id"),
  primary key (swap_id, item_id)
);

create index swap_items_item_idx on swap_items (item_id);

create table swap_participants (
  swap_id uuid not null references swaps ("id") on delete cascade,
  user_id text not null references "user" ("id") on delete cascade,
  role text not null check (role in ('requester', 'recipient')),
  confirmed_received_at timestamptz,
  primary key (swap_id, user_id)
);

create table swap_events (
  id bigserial primary key,
  swap_id uuid not null references swaps ("id") on delete cascade,
  actor_id text references "user" ("id"),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index swap_events_swap_idx on swap_events (swap_id, id);

-- Idempotency keys for POST endpoints (§4). Kept for 24 hours.
create table idempotency_keys (
  user_id text not null references "user" ("id") on delete cascade,
  key text not null,
  route text not null,
  request_hash text not null,
  response_status integer not null,
  response_body jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);
