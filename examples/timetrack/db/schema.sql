create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  role text not null default 'member' check (role in ('admin', 'member')),
  color text not null
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  default_rate integer not null default 0,
  currency text not null default 'NOK',
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id) on delete cascade,
  name text not null,
  code text not null,
  color text not null,
  billable boolean not null default true,
  hourly_rate integer,
  budget_hours integer,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  name text not null,
  billable boolean not null default true
);

create table if not exists project_members (
  project_id uuid not null references projects (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  primary key (project_id, user_id)
);

create table if not exists time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  task_id uuid references tasks (id) on delete set null,
  description text not null default '',
  started_at timestamptz not null,
  ended_at timestamptz,
  billable boolean not null default true,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at)
);

create index if not exists time_entries_user_started on time_entries (user_id, started_at);
create index if not exists time_entries_project on time_entries (project_id);
create unique index if not exists time_entries_one_running on time_entries (user_id) where ended_at is null;

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  threshold integer not null,
  created_at timestamptz not null default now(),
  unique (project_id, threshold)
);

alter table users replica identity full;
alter table customers replica identity full;
alter table projects replica identity full;
alter table tasks replica identity full;
alter table project_members replica identity full;
alter table time_entries replica identity full;
alter table alerts replica identity full;
