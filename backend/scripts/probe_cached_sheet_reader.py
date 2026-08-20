"""
Разведочный скрипт: проверяем кэширование архивных месяцев на живых
данных. Запускать вручную:
    python backend/scripts/probe_cached_sheet_reader.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ingestion.sheet_reader import get_sheet_values_cached  # noqa: E402
from app.sheets_client import get_service, SPREADSHEET_ID  # noqa: E402


def main():
    service = get_service()

    for sheet_name in ["Июнь", "Лист1"]:
        values = get_sheet_values_cached(service, SPREADSHEET_ID, sheet_name)
        print(f"'{sheet_name}': получено строк = {len(values)}\n")


if __name__ == "__main__":
    main()
