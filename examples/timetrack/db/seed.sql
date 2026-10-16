truncate alerts, time_entries, project_members, tasks, projects, customers, users cascade;

insert into users (name, role, color) values
  ('Ada', 'admin', '#7c5cff'),
  ('Grace', 'member', '#e5484d'),
  ('Linus', 'member', '#12a594');

insert into customers (name, default_rate) values
  ('Fjord Energy', 1450),
  ('Nordlys Media', 1200),
  ('Havn Logistics', 1350),
  ('Internal', 0);

insert into projects (customer_id, name, code, color, billable, hourly_rate, budget_hours)
select c.id, p.name, p.code, p.color, p.billable, p.rate, p.budget
from (values
  ('Fjord Energy', 'Grid Analytics', 'FJ-GRID', '#f59e0b', true, null::int, 300),
  ('Fjord Energy', 'Field Service App', 'FJ-APP', '#fb923c', true, 1550, 165),
  ('Nordlys Media', 'Website Relaunch', 'NM-WEB', '#3b82f6', true, null, 200),
  ('Nordlys Media', 'Brand Refresh', 'NM-BRAND', '#06b6d4', true, 1100, 128),
  ('Havn Logistics', 'Route Optimizer', 'HL-ROUTE', '#22c55e', true, null, 400),
  ('Internal', 'Admin & Ops', 'IN-OPS', '#94a3b8', false, null, null),
  ('Internal', 'Lyn Framework', 'IN-LYN', '#a855f7', false, null, null)
) as p (customer, name, code, color, billable, rate, budget)
join customers c on c.name = p.customer;

insert into tasks (project_id, name, billable)
select p.id, t.name, t.billable
from projects p
cross join lateral (
  select * from (values ('Design', true), ('Development', true), ('Meetings', true), ('QA', true)) as t (name, billable)
  where p.billable
  union all
  select * from (values ('Planning', false), ('Learning', false), ('Support', false)) as t (name, billable)
  where not p.billable
) t;

insert into project_members (project_id, user_id)
select p.id, u.id
from projects p
join users u on
  u.name = 'Ada'
  or (u.name = 'Grace' and p.code in ('FJ-GRID', 'NM-WEB', 'NM-BRAND', 'IN-OPS', 'IN-LYN'))
  or (u.name = 'Linus' and p.code in ('FJ-GRID', 'FJ-APP', 'HL-ROUTE', 'IN-OPS', 'IN-LYN'));

do $$
declare
  member record;
  day date;
  cursor_minutes int;
  length_minutes int;
  chosen record;
  want_billable boolean;
  today date := (now() at time zone 'Europe/Oslo')::date;
  local_now int := extract(hour from now() at time zone 'Europe/Oslo') * 60 + extract(minute from now() at time zone 'Europe/Oslo');
begin
  perform setseed(0.42);
  for member in select id, name from users order by name loop
    for day in select generate_series(today - 42, today, interval '1 day')::date loop
      continue when extract(isodow from day) > 5;
      cursor_minutes := 8 * 60 + (random() * 4)::int * 15;
      while cursor_minutes < 16 * 60 + 30 loop
        length_minutes := (3 + (random() * 9)::int) * 15;
        exit when day = today and cursor_minutes + length_minutes > local_now - 60;
        want_billable := random() >= 0.15;
        select p.id as project_id, p.billable, t.id as task_id, t.billable as task_billable, t.name as task_name, p.name as project_name
          into chosen
          from project_members pm
          join projects p on p.id = pm.project_id
          join tasks t on t.project_id = p.id
          where pm.user_id = member.id and p.billable = want_billable
          order by random()
          limit 1;
        insert into time_entries (user_id, project_id, task_id, description, started_at, ended_at, billable)
        values (
          member.id, chosen.project_id, chosen.task_id,
          (array['Sprint work', 'Review and fixes', 'Client call', 'Spec writing', 'Pairing', 'Prototype', 'Planning', 'Bug triage'])[1 + (random() * 7)::int],
          (day + make_interval(mins => cursor_minutes)) at time zone 'Europe/Oslo',
          (day + make_interval(mins => cursor_minutes + length_minutes)) at time zone 'Europe/Oslo',
          chosen.billable and chosen.task_billable
        );
        cursor_minutes := cursor_minutes + length_minutes + (random() * 2)::int * 15;
      end loop;
    end loop;
  end loop;
end $$;

insert into time_entries (user_id, project_id, task_id, description, started_at)
select u.id, p.id, t.id, 'Homepage hero animation', now() - interval '42 minutes'
from users u, projects p join tasks t on t.project_id = p.id and t.name = 'Development'
where u.name = 'Grace' and p.code = 'NM-WEB';
