# Food composition data

`cofid_2021_proximates.tsv` holds the core values from McCance and Widdowson's Composition of Foods Integrated Dataset (CoFID) 2021, one row per food, per 100 g edible portion:

| Column | Meaning |
| --- | --- |
| code | CoFID food code |
| name | CoFID food name |
| food_group | CoFID group code (first letter is the main group) |
| kcal | Energy, kcal |
| protein_g, fat_g, carb_g, sugars_g, fibre_g, water_g | grams (fibre is AOAC fibre) |
| edible_proportion | Share of the food as bought that is edible |

Extraction rules: "Tr" (trace) became 0, "N" (present but not measured) became blank, and 33 foods with no energy value (mostly dried spices) were left out. CoFID 2021 gives code 13-669 to two different foods; both are kept.

It's loaded into the `public.food_reference` table in Supabase with `supabase/seed/load_cofid.sql`.

Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Source: Public Health England (2021), McCance and Widdowson's The Composition of Foods Integrated Dataset 2021, [gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid](https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid).
