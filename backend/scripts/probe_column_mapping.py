"""
Разведочный скрипт: проверяем сопоставление заголовков WB с каноническими
именами в деле - на реальных данных из таблицы. Запускать вручную:
    python backend/scripts/probe_column_mapping.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.mapping.wb_columns import WB_COLUMN_MAP, build_column_index  # noqa: E402
from app.sheets_client import get_service, SPREADSHEET_ID  # noqa: E402

SHEET_NAME = "Лист1"


def main():
    service = get_service()

    # Читаем с запасом по столбцам (A:Z), но только первые 20 строк -
    # этого достаточно, чтобы увидеть заголовок и немного данных
    range_name = f"{SHEET_NAME}!A1:Z20"
    result = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID, range=range_name
    ).execute()

    values = result.get("values", [])
    if not values:
        print("Данные не найдены")
        return

    # В этой таблице первая строка - служебная ("Данные за период..."),
    # реальные заголовки колонок - вторая строка (индекс 1)
    header_row = values[1]
    data_rows = values[2:]

    column_index = build_column_index(header_row, WB_COLUMN_MAP)
    print(f"\nПостроен индекс колонок: {column_index}\n")

    # Проверяем индекс в деле: печатаем дату и заказы по каждой строке,
    # обращаясь по каноническому имени, а не по номеру позиции
    for row in data_rows:
        date = row[column_index["date"]] if "date" in column_index else "?"
        orders = row[column_index["orders_count"]] if "orders_count" in column_index else "?"
        print(f"date={date}  orders={orders}")


if __name__ == "__main__":
    main()
