#!/usr/bin/env python3
import sys, json, openpyxl
from datetime import datetime, date, timedelta

def fv(x):
    if x is None: return ''
    if isinstance(x, datetime): return ''
    try:
        n = float(x)
        return '' if n == 0 else round(n, 1)
    except: return ''

def run(filepath):
    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)

    # ── RECEPTURY ──
    ws_rec = wb['seznam balenéreceptury']
    receptury = []
    for row in ws_rec.iter_rows(min_row=2, values_only=True):
        if not row[0] or not row[1]: continue
        try: cislo = int(float(row[0]))
        except: continue
        receptury.append({
            'cislo': str(cislo), 'smes': str(row[1]).strip(),
            'zt': str(row[2]).strip() if row[2] else '',
            'c04': fv(row[3]), 'c24': fv(row[4]), 'c48': fv(row[5]), 'c811': fv(row[6]),
            'c1116': fv(row[7]), 'c1622': fv(row[8]),
            'b5070': fv(row[9]), 'b255560': fv(row[10]), 'b458065': fv(row[11]), 'b2030': fv(row[12]),
            'prach': fv(row[13]), 'vapenec': fv(row[14]), 'addbit': fv(row[15]),
            'scel': fv(row[16]), 'ra16': fv(row[17]), 'ra22': fv(row[18]), 'celkem': fv(row[19])
        })

    # ── TÝDENNÍ DATA ──
    # POZOR: sloupec A (cislo) obsahuje formuli =SUMIF(...) - čteme data_only=True
    # takže openpyxl vrátí výsledek, ale pro jistotu cislo bereme z dat receptur přes ITT
    week_sheets = [s for s in wb.sheetnames if s.isdigit()]
    
    # Mapa ITT -> číslo z receptur
    itt_to_cislo = {r['zt']: r['cislo'] for r in receptury if r['zt']}

    week_map = {}

    for sheet_name in week_sheets:
        ws = wb[sheet_name]
        all_rows = list(ws.iter_rows(max_row=35, values_only=True))
        if len(all_rows) < 3: continue

        # Datumy z řádku 2 (index 1), sloupce G-M (index 6-12)
        date_row = all_rows[1]
        dates = []
        for ci in range(6, 13):
            val = date_row[ci]
            if isinstance(val, datetime):
                dates.append(f"{val.year}-{str(val.month).zfill(2)}-{str(val.day).zfill(2)}")
            else:
                dates.append(None)

        week_start = dates[0]
        if not week_start: continue

        rows = []
        for row in all_rows[2:]:
            # Číslo může být formule - bereme z ITT
            smes = str(row[3]).strip() if row[3] else ''
            itt  = str(row[4]).strip() if row[4] else ''
            ceta = str(row[5]).strip() if row[5] else ''
            if not smes or not itt: continue

            # Cislo z mapy nebo z buňky
            cislo_raw = row[0]
            if cislo_raw and not isinstance(cislo_raw, str):
                try: cislo = str(int(float(cislo_raw)))
                except: cislo = itt_to_cislo.get(itt, '')
            else:
                cislo = itt_to_cislo.get(itt, '')

            # Objednávka
            obj_val = row[2]
            if isinstance(obj_val, float): obj_val = str(int(obj_val))
            elif obj_val is not None: obj_val = str(obj_val).strip()
            else: obj_val = ''

            entry = {
                'checked': False,
                'cislo': cislo,
                'lokalita': str(row[1]).strip() if row[1] else '',
                'objednavka': obj_val,
                'smes': smes, 'itt': itt, 'ceta': ceta
            }
            
            has_data = False
            for di in range(7):
                val = row[6 + di]
                if val and isinstance(val, (int, float)) and val > 0:
                    entry[f'd{di}'] = int(round(val))
                    has_data = True
                else:
                    entry[f'd{di}'] = ''
            
            # Přidej řádek i bez tun (pro zobrazení v týdenním kalendáři)
            rows.append(entry)

        if rows:
            week_map[week_start] = rows

    # ── MĚSÍČNÍ ZÁZNAMY ──
    hmg_entries = {}
    for week_start, rows in week_map.items():
        for r in rows:
            for di in range(7):
                tuny = r.get(f'd{di}', '')
                if not tuny: continue
                try: tuny = int(tuny)
                except: continue
                if tuny <= 0: continue
                d = date.fromisoformat(week_start) + timedelta(days=di)
                date_str = str(d)
                if date_str not in hmg_entries:
                    hmg_entries[date_str] = []
                hmg_entries[date_str].append({
                    'lokalita': r['lokalita'], 'objednavka': r['objednavka'],
                    'smes': r['smes'], 'itt': r['itt'], 'ceta': r['ceta'], 'tuny': tuny
                })

    print(json.dumps({
        'ok': True,
        'receptury': receptury,
        'weeks': week_map,
        'month_entries': hmg_entries
    }, ensure_ascii=False))

if __name__ == '__main__':
    try:
        run(sys.argv[1])
    except Exception as e:
        import traceback
        print(json.dumps({'ok': False, 'error': str(e) + '\n' + traceback.format_exc()}))
        sys.exit(1)
