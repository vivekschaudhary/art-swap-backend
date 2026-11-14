-- M3 catalog (docs/v1-design.md §5.3). No functions, triggers or rules (§1 principle 5).
-- gen_random_uuid() is a built-in function (PostgreSQL 13+) used as a column default.

create table categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  attribute_schema jsonb not null,
  is_active boolean not null default true,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into categories (slug, name, attribute_schema, sort_order) values (
  'art',
  'Art',
  '{
    "type": "object",
    "properties": {
      "medium": {"type": "string", "enum": ["oil", "acrylic", "watercolor", "ink", "pencil", "photo", "mixed", "sculpture", "other"]},
      "width_cm": {"type": "number", "exclusiveMinimum": 0},
      "height_cm": {"type": "number", "exclusiveMinimum": 0},
      "depth_cm": {"type": "number", "exclusiveMinimum": 0},
      "year": {"type": "integer", "minimum": 1000, "maximum": 2100},
      "artist_name": {"type": "string", "maxLength": 120},
      "framed": {"type": "boolean"},
      "signed": {"type": "boolean"}
    },
    "required": ["medium"],
    "additionalProperties": false
  }'::jsonb,
  0
);

create table items (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references "user" ("id") on delete cascade,
  category_id uuid references categories ("id"),
  title text check (char_length(title) between 1 and 120),
  description text check (char_length(description) <= 2000),
  attributes jsonb not null default '{}'::jsonb,
  condition text check (condition in ('new', 'like_new', 'good', 'fair')),
  source text not null default 'created' check (source in ('created', 'swap_received')),
  estimated_value_cents integer check (estimated_value_cents is null or estimated_value_cents >= 0),
  currency char(3),
  fulfillment_options text[] not null default '{local_pickup}',
  status text not null default 'draft' check (status in ('draft', 'available', 'reserved', 'swapped', 'archived')),
  location geography(Point, 4326),
  area_label text,
  origin_item_id uuid references items ("id"),
  published_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'draft' or (category_id is not null and title is not null and condition is not null))
);

create index items_owner_status_idx on items (owner_id, status, created_at desc);
create index items_owner_drafts_idx on items (owner_id, updated_at desc) where status = 'draft';
create index items_category_status_idx on items (category_id, status, published_at desc);
create index items_origin_idx on items (origin_item_id);
create index items_location_available_gix on items using gist (location) where status = 'available';

create table item_media (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items ("id") on delete cascade,
  kind text not null default 'image' check (kind = 'image'),
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  original_key text not null,
  variants jsonb,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  bytes integer not null check (bytes > 0 and bytes <= 15728640),
  width integer,
  height integer,
  blurhash text,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index item_media_item_position_idx on item_media (item_id, position);
