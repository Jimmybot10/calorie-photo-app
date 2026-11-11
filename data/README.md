# Food composition data

Values per 100 g, one food per row, loaded into the `public.food_reference` table in Supabase.

| File | Source | Foods | Licence |
| --- | --- | --- | --- |
| `cofid_2021_proximates.tsv` | McCance and Widdowson's Composition of Foods Integrated Dataset (CoFID) 2021, UK | 2,854 | Open Government Licence v3.0 |
| `usda_foundation_2026-10.tsv` | USDA FoodData Central, Foundation Foods, October 2026 | 374 | Public domain |
| `usda_sr_legacy_2018-04.tsv` | USDA FoodData Central, SR Legacy, April 2018 | 7,793 | Public domain |
| `usda_fndds_2021-2023.tsv` | USDA FoodData Central, FNDDS 2021–2023 (prepared foods and dishes) | 5,431 | Public domain |
| `ciqual_2020.tsv` | ANSES Ciqual 2020, English version (Zenodo, doi:10.5281/zenodo.4770202) | 2,298 | CC BY 4.0 |

## Columns

CoFID file: `code, name, food_group, kcal, protein_g, fat_g, carb_g, sugars_g, fibre_g, water_g, edible_proportion`.
Other files: `code, name, food_group, kcal, protein_g, carb_g, fat_g`.

`code` is the source's own ID: CoFID food code, USDA `fdcId`, or Ciqual `alim_code`.

## How values were extracted

- **CoFID:** "Tr" (trace) became 0, "N" (not measured) became blank. 33 foods with no energy value were left out. Code 13-669 is used for two different foods in the source; both are kept.
- **USDA:** energy is the reported kcal (nutrient 208), or else Atwater specific factors (958), or else Atwater general factors (957). Carbohydrate is "by difference" (205), or "by summation" (205.2). Fat is total lipid (204), or NLEA total fat (298). Negative values from "by difference" were set to 0. Foods with no energy value were left out (50 Foundation Foods, 1 FNDDS food).
- **Ciqual:** energy uses the EU Regulation 1169/2011 factors. Decimal commas were converted. "traces" became 0; "< x" became half of x. 888 foods with no EU energy value were left out.

Carbohydrate isn't defined the same way everywhere: CoFID reports available carbohydrate, USDA carbohydrate by difference (includes fibre), Ciqual carbohydrate excluding fibre. Energy is the figure to compare across sources.

## Credits

- Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Source: Public Health England (2021), McCance and Widdowson's The Composition of Foods Integrated Dataset 2021.
- U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, [fdc.nal.usda.gov](https://fdc.nal.usda.gov/).
- ANSES. Ciqual French food composition table 2020, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Values were reformatted (see above).

Loaded with `supabase/seed/load_cofid.sql` and `supabase/seed/load_more_sources.sql`.
