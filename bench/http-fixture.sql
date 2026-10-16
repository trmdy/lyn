insert into users(name, role, color)
select 'Perf ' || lpad(n::text, 2, '0'), 'member', '#7c5cff' from generate_series(1,47) n;
insert into project_members select p.id,u.id from projects p cross join users u on conflict do nothing;
insert into time_entries(user_id,project_id,task_id,description,started_at,ended_at,billable)
select u.id,p.id,t.id,'Perf fixture',d.day + make_interval(hours=>8+n*2),d.day + make_interval(hours=>10+n*2),true
from users u cross join generate_series('2025-10-20'::timestamptz,'2026-10-18'::timestamptz,interval '1 day') d(day)
cross join generate_series(0,3) n
cross join lateral (select id from projects order by code limit 1) p
cross join lateral (select id from tasks where project_id=p.id order by name limit 1) t
where extract(isodow from d.day)<=5;
analyze;
