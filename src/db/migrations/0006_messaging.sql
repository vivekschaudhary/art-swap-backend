-- M6 messaging and notifications (docs/v1-design.md §5.6). No functions, triggers or rules (§1 principle 5).

create table conversations (
  id uuid primary key default gen_random_uuid(),
  swap_id uuid unique references swaps ("id") on delete cascade,
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create index conversations_last_message_idx on conversations (last_message_at desc);

create table conversation_participants (
  conversation_id uuid not null references conversations ("id") on delete cascade,
  user_id text not null references "user" ("id") on delete cascade,
  last_read_message_id uuid,
  muted_until timestamptz,
  primary key (conversation_id, user_id)
);

create index conversation_participants_user_idx on conversation_participants (user_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations ("id") on delete cascade,
  sender_id text references "user" ("id") on delete set null,
  kind text not null default 'text' check (kind in ('text', 'image', 'system')),
  body text check (char_length(body) between 1 and 4000),
  attachments jsonb not null default '[]'::jsonb,
  client_message_id text,
  created_at timestamptz not null default now(),
  unique (conversation_id, sender_id, client_message_id)
);

create index messages_conversation_idx on messages (conversation_id, created_at desc, id desc);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user" ("id") on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on notifications (user_id, created_at desc);
create index notifications_unread_idx on notifications (user_id) where read_at is null;
