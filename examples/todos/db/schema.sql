create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

insert into users (name) values ('Ada'), ('Grace') on conflict (name) do nothing;

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

alter table lists add column if not exists owner_id uuid references users (id) on delete cascade;
update lists set owner_id = (select id from users where name = 'Ada') where owner_id is null;
alter table lists alter column owner_id set not null;

create table if not exists todos (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists (id) on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

alter table activity add column if not exists user_id uuid references users (id) on delete cascade;
delete from activity where user_id is null;
alter table activity alter column user_id set not null;

alter table users replica identity full;
alter table lists replica identity full;
alter table todos replica identity full;
alter table activity replica identity full;

insert into lists (name, owner_id)
select seed.name, users.id
from (values ('Ada', 'Groceries'), ('Ada', 'Lyn.js'), ('Grace', 'Compilers')) as seed (owner, name)
join users on users.name = seed.owner
where not exists (select 1 from lists where lists.owner_id = users.id);

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'lyn_app') then
    create role lyn_app nologin;
  end if;
end $$;

grant usage on schema public to lyn_app;
grant select, insert, update, delete on all tables in schema public to lyn_app;

create or replace function current_user_id() returns uuid
language sql stable
as $$ select (nullif(current_setting('lyn.session', true), '')::jsonb ->> 'userId')::uuid $$;

alter table lists enable row level security;
drop policy if exists owner on lists;
create policy owner on lists
  using (owner_id = current_user_id())
  with check (owner_id = current_user_id());

alter table todos enable row level security;
drop policy if exists owner on todos;
create policy owner on todos
  using (exists (select 1 from lists where lists.id = todos.list_id))
  with check (exists (select 1 from lists where lists.id = todos.list_id));

alter table activity enable row level security;
drop policy if exists owner on activity;
create policy owner on activity using (user_id = current_user_id());
