-- Load the USDA and Ciqual files in data/ into public.food_reference.
-- Same approach as load_cofid.sql: fetch each file from this public repo with pg_net,
-- insert, then remove pg_net. Run one step at a time in the Supabase SQL editor.

-- 1. Fetch the four files; note the request ids.
create extension if not exists pg_net;
select 'usda_foundation' as source, net.http_get('https://raw.githubusercontent.com/Jimmybot10/calorie-photo-app/main/data/usda_foundation_2026-10.tsv', timeout_milliseconds := 30000) as request_id
union all select 'usda_sr_legacy', net.http_get('https://raw.githubusercontent.com/Jimmybot10/calorie-photo-app/main/data/usda_sr_legacy_2018-04.tsv', timeout_milliseconds := 30000)
union all select 'usda_fndds', net.http_get('https://raw.githubusercontent.com/Jimmybot10/calorie-photo-app/main/data/usda_fndds_2021-2023.tsv', timeout_milliseconds := 30000)
union all select 'ciqual_2020', net.http_get('https://raw.githubusercontent.com/Jimmybot10/calorie-photo-app/main/data/ciqual_2020.tsv', timeout_milliseconds := 30000);

-- 2. A few seconds later, check they arrived (status 200).
select id, status_code, length(content) from net._http_response order by id desc limit 4;

-- 3. Load each one. Replace REQUEST_ID and SOURCE for each file in turn.
with body as (
  select content from net._http_response where id = REQUEST_ID and status_code = 200
), lines as (
  select line, n from body, string_to_table(content, E'\n') with ordinality as l(line, n)
  where n > 1 and line <> ''
), fields as (
  select string_to_array(line, E'\t') as f from lines
)
insert into public.food_reference (source, code, name, group_label, kcal_per_100g, protein_g, carb_g, fat_g)
select 'SOURCE', f[1], f[2], nullif(left(f[3], 80), ''), f[4]::numeric,
       nullif(f[5], '')::numeric, nullif(f[6], '')::numeric, nullif(f[7], '')::numeric
from fields
on conflict (source, code, name) do update set
  group_label = excluded.group_label, kcal_per_100g = excluded.kcal_per_100g,
  protein_g = excluded.protein_g, carb_g = excluded.carb_g, fat_g = excluded.fat_g;

-- 4. Tidy up and check.
drop extension pg_net;
select source, count(*) from public.food_reference group by source order by source;
