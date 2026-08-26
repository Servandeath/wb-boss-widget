"""
Разведочный скрипт: снимок ключевых вкладок фин.отчёта и агрегатора
рекламы в backend/cache/cost_sheets/ - понять реальный расчёт маржи
(комиссия/логистика/хранение/реклама), а не только forPay-Себес.

Часть вкладок читаем с рендером FORMULA - нужно увидеть сами формулы
расчёта, а не только посчитанные значения (по просьбе владельца таблиц).
Только чтение. Запускать вручную:

    python backend/scripts/probe_fin_report.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.sheets_client import get_service  # noqa: E402

BACKEND_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = BACKEND_DIR / "cache" / "cost_sheets"

FIN_OTCHET_ID = "1Cxg8nshaIL-Cgd5hJXVXRJvwL8xks2mGktqy2c121mI"
REKLAMA_ID = "187H8ckzzzlsLzjpQ0gyPQHWbwf7pPyRZJ3tcO4yse-E"

# (spreadsheet_id, sheet_name, диапазон, value_render_option, файл_кэша)
TARGETS = [
    (FIN_OTCHET_ID, "Выгрузка", "A1:CV6", "UNFORMATTED_VALUE", "fin_otchet_vygruzka.json"),
    (FIN_OTCHET_ID, "Себес фикс", "A1:S10", "UNFORMATTED_VALUE", "fin_otchet_sebes_fix.json"),
    (FIN_OTCHET_ID, "КОМИ", "A1:B10", "UNFORMATTED_VALUE", "fin_otchet_komi.json"),
    (FIN_OTCHET_ID, "ГлавСвод", "A1:AJ10", "FORMULA", "fin_otchet_glavsvod_formulas.json"),
    (FIN_OTCHET_ID, "ГлавСвод", "A1:AJ10", "UNFORMATTED_VALUE", "fin_otchet_glavsvod_values.json"),
    (REKLAMA_ID, "Затраты", "A1:Q10", "UNFORMATTED_VALUE", "reklama_zatraty.json"),
    (REKLAMA_ID, "ВСЕ", "A1:AK6", "UNFORMATTED_VALUE", "reklama_vse.json"),
]


def main():
    service = get_service()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    for spreadsheet_id, sheet_name, cell_range, render_option, cache_file in TARGETS:
        range_name = f"{sheet_name}!{cell_range}"
        print(f"=== {sheet_name} [{render_option}] ({spreadsheet_id}) ===")

        try:
            result = (
                service.spreadsheets()
                .values()
                .get(
                    spreadsheetId=spreadsheet_id,
                    range=range_name,
                    valueRenderOption=render_option,
                )
                .execute()
            )
        except Exception as e:
            print(f"ОШИБКА: {e}\n")
            continue

        values = result.get("values", [])
        (CACHE_DIR / cache_file).write_text(
            json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        for i, row in enumerate(values, start=1):
            print(f"{i}: {row}")
        print(f"-> сохранено в cache/cost_sheets/{cache_file}\n")


if __name__ == "__main__":
    main()
