"""
Разведочный скрипт: получаем список всех листов (вкладок) в таблице -
нужно, чтобы отличить архивные месяцы (Январь, Февраль, ...) от текущего
Лист1. Запускать вручную:
    python backend/scripts/probe_list_sheets.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ingestion.sheet_reader import MONTH_SHEETS  # noqa: E402
from app.sheets_client import get_service, SPREADSHEET_ID  # noqa: E402


def main():
    service = get_service()

    # Запрос БЕЗ диапазона - получаем метаданные всей таблицы,
    # а не данные конкретного листа
    metadata = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()

    sheet_titles = [s["properties"]["title"] for s in metadata["sheets"]]
    print(f"Все листы в таблице: {sheet_titles}\n")

    archive_sheets = [s for s in sheet_titles if s in MONTH_SHEETS]
    live_sheets = [s for s in sheet_titles if s not in MONTH_SHEETS]

    print(f"Архивные (можно кэшировать): {archive_sheets}")
    print(f"Живые (читать каждый раз заново): {live_sheets}")


if __name__ == "__main__":
    main()
