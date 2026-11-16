-- M4 discovery (docs/v1-design.md §5.4). No functions, triggers or rules (§1 principle 5).

create table swipes (
  user_id text not null references "user" ("id") on delete cascade,
  item_id uuid not null references items ("id") on delete cascade,
  direction text not null check (direction in ('left', 'right')),
  created_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

-- Supports "who liked my items" later, and likes listing.
create index swipes_item_right_idx on swipes (item_id) where direction = 'right';
create index swipes_user_right_idx on swipes (user_id, created_at desc, item_id) where direction = 'right';
