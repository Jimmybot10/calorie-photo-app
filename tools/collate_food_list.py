"""Collate open food composition tables into one workbook.
Usage: python collate.py OUT.xlsx COFID_TSV [--usda-foundation ZIP] [--usda-sr ZIP] [--usda-fndds ZIP] [--ciqual XLSX]
"""
import sys, json, zipfile, argparse
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

GROUPS = {"A":"Cereals","B":"Milk and dairy","C":"Eggs","D":"Vegetables","F":"Fruit","G":"Nuts and seeds","H":"Herbs and spices",
          "J":"Fish","M":"Meat","O":"Fats and oils","P":"Drinks","Q":"Alcoholic drinks","S":"Sugars and snacks","W":"Soups and sauces"}

def num(v):
    if v in (None, ""): return None
    try: return round(float(v), 1)
    except ValueError: return None

def load_cofid(path):
    rows = []
    for line in open(path, encoding="utf-8").read().splitlines()[1:]:
        f = line.split("\t")
        rows.append(("CoFID 2021", f[0], f[1], GROUPS.get(f[2][:1].upper(), ""), num(f[3]), num(f[4]), num(f[6]), num(f[5])))
    return rows

def load_usda_json(path, label):
    if path.endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            name = [n for n in z.namelist() if n.lower().endswith(".json")][0]
            data = json.loads(z.read(name))
    else:
        data = json.load(open(path, encoding="utf-8"))
    foods = next(v for v in data.values() if isinstance(v, list))
    rows = []
    def first(nut, *keys):
        for k in keys:
            if nut.get(k) is not None:
                return nut[k]
        return None
    for food in foods:
        nut = {}
        for fn in food.get("foodNutrients", []):
            n = fn.get("nutrient", {})
            key = str(n.get("number", ""))
            unit = (n.get("unitName") or "").lower()
            if key and fn.get("amount") is not None:
                nut[(key, unit)] = fn["amount"]
        # Energy: reported kcal, else Atwater specific factors, else Atwater general factors
        kcal = first(nut, ("208", "kcal"), ("958", "kcal"), ("957", "kcal"))
        carb = first(nut, ("205", "g"), ("205.2", "g"))
        fat = first(nut, ("204", "g"), ("298", "g"))
        group = (food.get("foodCategory") or {}).get("description") or (food.get("wweiaFoodCategory") or {}).get("wweiaFoodCategoryDescription") or ""
        if kcal is None:
            continue
        pos = lambda v: None if v is None else max(0.0, num(v))   # carbohydrate by difference can dip below zero
        rows.append((label, str(food.get("fdcId", "")), " ".join(str(food.get("description", "")).split()), group,
                     pos(kcal), pos(nut.get(("203", "g"))), pos(carb), pos(fat)))
    return rows

def ciqual_num(v):
    if v is None: return None
    s = str(v).strip().replace(",", ".")
    if s in ("", "-", "nan"): return None
    if s.lower() == "traces": return 0.0
    if s.startswith("<"):
        try: return round(float(s[1:].strip()) / 2, 2)   # below the limit: take half of it
        except ValueError: return None
    try: return round(float(s), 1)
    except ValueError: return None

def load_ciqual(path):
    import pandas as pd
    df = pd.read_excel(path, sheet_name=0, engine="xlrd", dtype=str)
    col = lambda prefix: next(c for c in df.columns if c.startswith(prefix))
    k, p, c, f = col("Energy, Regulation EU No 1169/2011 (kcal"), col("Protein (g"), col("Carbohydrate (g"), col("Fat (g")
    rows = []
    for _, r in df.iterrows():
        kcal = ciqual_num(r[k])
        if kcal is None: continue
        grp = r.get("alim_ssgrp_nom_eng")
        grp = grp if isinstance(grp, str) and grp.strip() not in ("", "-") else (r.get("alim_grp_nom_eng") or "")
        rows.append(("Ciqual 2020", str(r["alim_code"]).strip(), " ".join(str(r["alim_nom_eng"]).split()), str(grp).strip(),
                     kcal, ciqual_num(r[p]), ciqual_num(r[c]), ciqual_num(r[f])))
    return rows

def build(out, sources):
    wb = Workbook()
    ws = wb.active; ws.title = "All foods"
    hdr = ["source", "code", "name", "food_group", "kcal_per_100g", "protein_g", "carb_g", "fat_g"]
    widths = [16, 12, 70, 26, 14, 11, 10, 9]
    for i, (h, w) in enumerate(zip(hdr, widths), start=1):
        c = ws.cell(row=1, column=i, value=h)
        c.font = Font(name="Arial", bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="1F6B4E")
        ws.column_dimensions[c.column_letter].width = w
    r = 2
    body = Font(name="Arial")
    for rows in sources.values():
        for row in rows:
            for ci, v in enumerate(row, start=1):
                c = ws.cell(row=r, column=ci, value=v); c.font = body
                if ci >= 5: c.number_format = "0.0"
            r += 1
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:H{r-1}"
    about = wb.create_sheet("About")
    about.column_dimensions["A"].width = 22; about.column_dimensions["B"].width = 110
    lines = [("Calorie Lab food list", ""), ("", ""),
             ("Values", "Per 100 g of the food as described. Blank = not measured. Foods with no energy value are left out."),
             ("Energy", "CoFID and Ciqual: EU/UK label energy. USDA: reported kcal, or Atwater specific factors, or Atwater general factors, in that order."),
             ("Carbohydrate", "CoFID: available carbohydrate. USDA: carbohydrate by difference (includes fibre). Ciqual: carbohydrate (excludes fibre)."),
             ("Ciqual '<' values", "Where Ciqual gives '< x' the list uses half of x; 'traces' is 0."),
             ("Rows by source", "")]
    for k, v in sources.items(): lines.append(("", f"{k}: {len(v):,} foods"))
    lines += [("", ""), ("Licences", ""),
              ("CoFID 2021", "Contains public sector information licensed under the Open Government Licence v3.0. McCance and Widdowson's Composition of Foods Integrated Dataset."),
              ("USDA FoodData Central", "U.S. Department of Agriculture, Agricultural Research Service. FoodData Central. Public domain."),
              ("Ciqual 2020", "ANSES. Ciqual French food composition table 2020, English version (Zenodo, doi:10.5281/zenodo.4770202). CC BY 4.0.")]
    for i, (a, b) in enumerate(lines, start=1):
        about.cell(row=i, column=1, value=a).font = Font(name="Arial", bold=(i == 1 or a in ("Values", "Rows by source", "Licences")), size=14 if i == 1 else 10)
        about.cell(row=i, column=2, value=b).font = Font(name="Arial")
    wb.save(out)
    return r - 2

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out"); ap.add_argument("cofid")
    ap.add_argument("--usda-foundation"); ap.add_argument("--usda-sr"); ap.add_argument("--usda-fndds"); ap.add_argument("--ciqual"); ap.add_argument("--tsv-dir")
    a = ap.parse_args()
    sources = {"CoFID 2021 (UK)": load_cofid(a.cofid)}
    if a.usda_foundation: sources["USDA Foundation Foods"] = load_usda_json(a.usda_foundation, "USDA Foundation")
    if a.usda_sr: sources["USDA SR Legacy"] = load_usda_json(a.usda_sr, "USDA SR Legacy")
    if a.usda_fndds: sources["USDA FNDDS (dishes)"] = load_usda_json(a.usda_fndds, "USDA FNDDS")
    if a.ciqual: sources["Ciqual 2020 (France)"] = load_ciqual(a.ciqual)
    if a.tsv_dir:
        import os
        os.makedirs(a.tsv_dir, exist_ok=True)
        for key, rows in sources.items():
            if key.startswith("CoFID"): continue
            slug = {"USDA Foundation Foods": "usda_foundation_2026-10", "USDA SR Legacy": "usda_sr_legacy_2018-04",
                    "USDA FNDDS (dishes)": "usda_fndds_2021-2023", "Ciqual 2020 (France)": "ciqual_2020"}[key]
            with open(f"{a.tsv_dir}/{slug}.tsv", "w", encoding="utf-8") as fh:
                fh.write("code\tname\tfood_group\tkcal\tprotein_g\tcarb_g\tfat_g\n")
                for row in rows:
                    vals = ["" if v is None else str(v) for v in row[1:]]
                    assert all("\t" not in v and "\n" not in v for v in vals)
                    fh.write("\t".join(vals) + "\n")
    print("rows", build(a.out, sources), {k: len(v) for k, v in sources.items()})
