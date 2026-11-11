import openpyxl, sys, csv, collections
src, out = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src, read_only=True)
def num(v):
    if v is None: return None
    s = str(v).strip()
    if s == "" or s.upper() == "N": return None
    if s.lower() == "tr": return 0.0
    try: return float(s)
    except ValueError: return None
edible = {}
for r in wb['1.2 Factors'].iter_rows(min_row=4, values_only=True):
    if r[0]: edible[str(r[0]).strip()] = num(r[7])
rows = []
for r in wb['1.3 Proximates'].iter_rows(min_row=4, values_only=True):
    code = r[0]
    if not code: continue
    code = str(code).strip(); name = " ".join(str(r[1]).split())
    rows.append(dict(code=code, name=name, grp=(str(r[3]).strip() if r[3] else ""),
        kcal=num(r[12]), protein=num(r[9]), fat=num(r[10]), carb=num(r[11]), sugars=num(r[16]),
        fibre=num(r[25]), water=num(r[7]), edible=edible.get(code)))
print("rows", len(rows))
print("no kcal", sum(1 for r in rows if r['kcal'] is None))
print("max name len", max(len(r['name']) for r in rows), "avg", sum(len(r['name']) for r in rows)/len(rows))
print("names >80", sum(1 for r in rows if len(r['name'])>80))
print("dup codes", [c for c,n in collections.Counter(r['code'] for r in rows).items() if n>1][:5])
print("first letters", collections.Counter(r['grp'][:1] for r in rows))
print("kcal max", max(r['kcal'] or 0 for r in rows))
for chk in ("\t","\n","\r"):
    print(repr(chk), sum(1 for r in rows if chk in r['name']))
rows = [r for r in rows if r['kcal'] is not None]
fmt = lambda v: "" if v is None else (str(int(v)) if float(v).is_integer() else str(v))
cols = ["code","name","food_group","kcal","protein_g","fat_g","carb_g","sugars_g","fibre_g","water_g","edible_proportion"]
with open(out, "w") as f:
    f.write("\t".join(cols) + "\n")
    for r in rows:
        vals = [r['code'], r['name'], r['grp']] + [fmt(r[k]) for k in ('kcal','protein','fat','carb','sugars','fibre','water','edible')]
        assert all("\t" not in v and "\n" not in v for v in vals)
        f.write("\t".join(vals) + "\n")
print("written", len(rows))
