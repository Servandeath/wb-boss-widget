"""
Разведочный скрипт: снимок нужных вкладок cost-таблиц в
backend/cache/cost_sheets/*.json - чтобы дальше проектировать маппинг
полей (себестоимость, комиссия и т.д.) по сохранённому снимку, а не
дёргать Google Sheets API заново на каждый вопрос. Кэш в .gitignore
(backend/cache/), не публикуется. Только чтение. Запускать вручную:

    python backend/scripts/probe_cost_sheet_headers.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.sheets_client import get_service  # noqa: E402

BACKEND_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = BACKEND_DIR / "cache" / "cost_sheets"
ROWS_TO_SHOW = 15

# (spreadsheet_id, sheet_name, файл_кэша)
TARGETS = [
    ("12cY9FXrHuMAHYG13jjZOGAAiqeFK_qJCKousASx3kWU", "Главный", "wb_kartochki_glavnyi.json"),
    ("12cY9FXrHuMAHYG13jjZOGAAiqeFK_qJCKousASx3kWU", "Коми", "wb_kartochki_komi.json"),
    ("1QZN-M2Q7OYhC8b5uHW2ZDx84PR1zoDxavLo2EKGtHA8", "МС+", "stok_vb_ms_plus.json"),
    ("1QZN-M2Q7OYhC8b5uHW2ZDx84PR1zoDxavLo2EKGtHA8", "Ультра", "stok_vb_ultra.json"),
]


def main():
    service = get_service()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    for spreadsheet_id, sheet_name, cache_file in TARGETS:
        range_name = f"{sheet_name}!A1:Z{ROWS_TO_SHOW}"
        print(f"=== {sheet_name} ({spreadsheet_id}) ===")

        try:
            result = (
                service.spreadsheets()
                .values()
                .get(spreadsheetId=spreadsheet_id, range=range_name)
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
