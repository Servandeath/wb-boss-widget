"""
Разведочный скрипт: проверяем, что service account может прочитать данные
из таблицы. Ничего не считаем, не пишем в SQLite - только смотрим,
что API вообще отвечает и отдаёт данные.

Это ручная проверка, а не автоматический тест (несмотря на то, что раньше
файл назывался test_read_sheet.py) - запускать вручную:
    python backend/scripts/probe_read_sheet.py
"""

import sys
from pathlib import Path

# Добавляем backend/ в sys.path, чтобы работал импорт `app.*`
# независимо от того, из какой директории запущен скрипт.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.sheets_client import get_service, SPREADSHEET_ID  # noqa: E402

# Какой лист и диапазон читаем. A1:J20 - первые 20 строк, чтобы
# не тащить сразу всю таблицу на этапе проверки
RANGE_NAME = "Лист1!A1:J20"


def main():
    service = get_service()

    result = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID, range=RANGE_NAME
    ).execute()

    values = result.get("values", [])

    if not values:
        print("Данные не найдены - проверь доступ или название листа")
        return

    print(f"Получено строк: {len(values)}\n")
    for row in values:
        print(row)


if __name__ == "__main__":
    main()
