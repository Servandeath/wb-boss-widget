"""
Себестоимость из локального CSV вместо Google Sheets ("Ультра" из
cost_sheets.py - таблицы переделаны и для backend больше не актуальны).

Формат backend/data/costs.csv (в .gitignore - реальные цифры кабинетов):

    nm_id;tech_size;cost
    248314348;42;1250.50

Разделитель ";" или "," (определяется по заголовку), десятичная
запятая допустима - файл обычно выгружают из Excel. Ключ тот же, что
был у "Ультра": "<nmId>-<techSize>". Себестоимость общая для всех
кабинетов (артикулы WB уникальны). Пример - backend/data/costs.example.csv.
"""

import csv
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
COSTS_CSV_PATH = BACKEND_DIR / "data" / "costs.csv"


def cost_key(nm_id, tech_size) -> str:
    return f"{str(nm_id).strip()}-{str(tech_size).strip()}"


def load_cost_lookup(path: Path | None = None) -> dict[str, float]:
    """{"<nmId>-<techSize>": себестоимость единицы}. Нет файла - пустой словарь."""
    path = path or COSTS_CSV_PATH
    if not path.exists():
        return {}

    with path.open(encoding="utf-8-sig", newline="") as f:
        header = f.readline()
        delimiter = ";" if header.count(";") >= header.count(",") else ","
        f.seek(0)
        lookup = {}
        for row in csv.DictReader(f, delimiter=delimiter):
            raw_cost = (row.get("cost") or "").strip().replace(" ", "").replace(",", ".")
            if not row.get("nm_id") or not raw_cost:
                continue
            lookup[cost_key(row["nm_id"], row.get("tech_size", ""))] = float(raw_cost)

    return lookup
