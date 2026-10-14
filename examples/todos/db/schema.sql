create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists todos (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists (id) on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists activity (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  created_at timestamptz not null default now()
);

alter table lists replica identity full;
alter table todos replica identity full;
alter table activity replica identity full;

insert into lists (name)
select name from (values ('Groceries'), ('Lyn.js')) as seed (name)
where not exists (select 1 from lists);
