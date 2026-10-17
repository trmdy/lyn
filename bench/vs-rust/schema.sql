drop publication if exists vs_pub;
drop table if exists items;
create table items (id int primary key, grp int not null, label text not null, val int not null);
alter table items replica identity full;
insert into items select g, (g - 1) / 20 + 1, 'item ' || g, g % 97 from generate_series(1, :groups * 20) g;
create index items_grp on items (grp, id);
create publication vs_pub for table items;
analyze items;
