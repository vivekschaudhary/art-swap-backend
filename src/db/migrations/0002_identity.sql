-- M2 identity tables (docs/v1-design.md §5.2). Foreign keys point at Better Auth's "user" table.
-- No functions, triggers or rules (§1 principle 5).

create extension if not exists postgis;

create table profiles (
  user_id text primary key references "user" ("id") on delete cascade,
  display_name text check (char_length(display_name) between 1 and 50),
  bio text check (char_length(bio) <= 500),
  avatar_key text,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_locations (
  user_id text primary key references "user" ("id") on delete cascade,
  location geography(Point, 4326) not null,
  area_label text not null,
  search_radius_km smallint not null default 25 check (search_radius_km between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index user_locations_location_gix on user_locations using gist (location);

create table blocks (
  blocker_id text not null references "user" ("id") on delete cascade,
  blocked_id text not null references "user" ("id") on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index blocks_blocked_id_idx on blocks (blocked_id);
